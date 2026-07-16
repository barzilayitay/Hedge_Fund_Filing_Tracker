import type { Sql } from "../db/sql";
import { normalizeCusip } from "./parse13f";
import {
  buildSecuritySeed,
  buildTickerIndex,
  parse13fList,
  parseCompanyTickers,
  type MappingStatus,
  type SeedSecurity,
} from "./secReference";

/**
 * CUSIP -> ticker resolution.
 *
 * `securities` is the cache and the source of truth: a row exists for every
 * CUSIP we have ever seen, mapped or not, so an unresolvable CUSIP can never
 * block ingestion (ARCHITECTURE.md decision 5). Resolution order is
 * seed/cache first, then OpenFIGI for whatever is still unmapped.
 */

/** OpenFIGI accepts at most 100 jobs per request on the free tier. */
export const OPENFIGI_BATCH_SIZE = 100;

export interface FigiMatch {
  ticker: string;
  name: string | null;
}

/** Injected so tests can supply matches without touching the network. */
export interface OpenFigiClient {
  /** Resolve a batch of at most OPENFIGI_BATCH_SIZE CUSIPs. */
  mapCusips(cusips: string[]): Promise<Map<string, FigiMatch | null>>;
}

export interface ResolvedSecurity {
  cusip: string;
  ticker: string | null;
  name: string | null;
  mappingStatus: MappingStatus;
}

interface SecurityRow {
  cusip: string;
  ticker: string | null;
  name: string | null;
  mapping_status: MappingStatus;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toResolved(row: SecurityRow): ResolvedSecurity {
  return {
    cusip: row.cusip,
    ticker: row.ticker,
    name: row.name,
    mappingStatus: row.mapping_status,
  };
}

/**
 * Seed `companies` from company_tickers.json.
 *
 * Deviation from the spec (recorded in PROGRESS.md): the spec says to seed
 * `securities` from this file, but it contains no CUSIPs and `securities` is
 * keyed on CUSIP, so it cannot. Per ARCHITECTURE.md this file is the ticker
 * map seed, which is what `companies` (cik, ticker, name) holds.
 */
export async function seedCompanies(
  sql: Sql,
  companyTickersJson: string,
): Promise<number> {
  const entries = parseCompanyTickers(companyTickersJson);
  if (entries.length === 0) return 0;

  // One CIK can appear under several tickers (Alphabet files GOOGL and GOOG),
  // and `companies` holds a single ticker per issuer. Keep the first listing —
  // the file is ordered by size, so that is the primary class — and make the
  // de-duplication explicit rather than letting ON CONFLICT hit a row twice in
  // the same statement, which Postgres rejects outright.
  const byCik = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    if (!byCik.has(e.cik)) byCik.set(e.cik, e);
  }
  const rows = [...byCik.values()];

  await sql.query(
    `insert into companies (cik, ticker, name)
     select * from unnest($1::text[], $2::text[], $3::text[])
     on conflict (cik) do update
       set ticker = excluded.ticker, name = excluded.name`,
    [rows.map((e) => e.cik), rows.map((e) => e.ticker), rows.map((e) => e.name)],
  );
  return rows.length;
}

/**
 * Seed `securities` with CUSIPs from the Official List of Section 13(f)
 * Securities, resolving tickers by joining issuer names to company_tickers.
 *
 * Never downgrades a row that OpenFIGI has already mapped.
 */
export async function seedSecurities(
  sql: Sql,
  thirteenFListText: string,
  companyTickersJson: string,
): Promise<{ total: number; mapped: number; ambiguous: number; unmapped: number }> {
  const seed = buildSecuritySeed(
    parse13fList(thirteenFListText),
    buildTickerIndex(parseCompanyTickers(companyTickersJson)),
  );
  await upsertSeed(sql, seed);

  return {
    total: seed.length,
    mapped: seed.filter((s) => s.mappingStatus === "mapped").length,
    ambiguous: seed.filter((s) => s.mappingStatus === "ambiguous").length,
    unmapped: seed.filter((s) => s.mappingStatus === "unmapped").length,
  };
}

async function upsertSeed(sql: Sql, seed: SeedSecurity[]): Promise<void> {
  if (seed.length === 0) return;

  // The list can contain a CUSIP twice; keep the last occurrence so the
  // statement's ON CONFLICT never sees a duplicate in the same command.
  const byCusip = new Map(seed.map((s) => [s.cusip, s]));
  const rows = [...byCusip.values()];

  await sql.query(
    `insert into securities (cusip, ticker, name, mapping_status)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::text[])
     on conflict (cusip) do update
       set ticker = coalesce(securities.ticker, excluded.ticker),
           name = coalesce(excluded.name, securities.name),
           mapping_status = case
             when securities.mapping_status = 'mapped' then 'mapped'
             else excluded.mapping_status
           end`,
    [
      rows.map((r) => r.cusip),
      rows.map((r) => r.ticker),
      rows.map((r) => r.name),
      rows.map((r) => r.mappingStatus),
    ],
  );
}

/**
 * Make sure a `securities` row exists for every CUSIP, without disturbing any
 * mapping already recorded. Called before holdings are written so the
 * holdings -> securities foreign key always holds.
 */
export async function ensureSecurities(sql: Sql, cusips: string[]): Promise<void> {
  const unique = [...new Set(cusips.map(normalizeCusip))];
  if (unique.length === 0) return;

  await sql.query(
    `insert into securities (cusip, mapping_status)
     select cusip, 'unmapped' from unnest($1::text[]) as cusip
     on conflict (cusip) do nothing`,
    [unique],
  );
}

/**
 * Resolve CUSIPs to tickers: cache first, OpenFIGI for the rest.
 *
 * Results are persisted either way — a CUSIP OpenFIGI cannot match is stored
 * as 'unmapped' rather than dropped, so it surfaces for later resolution
 * instead of silently failing.
 */
export async function resolveCusips(
  sql: Sql,
  cusips: string[],
  figi: OpenFigiClient,
): Promise<Map<string, ResolvedSecurity>> {
  const wanted = [...new Set(cusips.map(normalizeCusip))];
  const resolved = new Map<string, ResolvedSecurity>();
  if (wanted.length === 0) return resolved;

  await ensureSecurities(sql, wanted);

  const cached = await sql.query<SecurityRow>(
    `select cusip, ticker, name, mapping_status
       from securities where cusip = any($1::text[])`,
    [wanted],
  );
  for (const row of cached) resolved.set(row.cusip, toResolved(row));

  // Anything the seed already mapped needs no OpenFIGI call. Ambiguous rows
  // are sent too: OpenFIGI can disambiguate share classes that a name match
  // cannot.
  const needsLookup = wanted.filter(
    (c) => resolved.get(c)?.mappingStatus !== "mapped",
  );
  if (needsLookup.length === 0) return resolved;

  for (const batch of chunk(needsLookup, OPENFIGI_BATCH_SIZE)) {
    const matches = await figi.mapCusips(batch);

    const updates = batch.map((cusip) => {
      const match = matches.get(cusip) ?? null;
      return {
        cusip,
        ticker: match?.ticker ?? null,
        name: match?.name ?? null,
        status: (match ? "mapped" : "unmapped") satisfies MappingStatus as MappingStatus,
      };
    });

    await sql.query(
      `insert into securities (cusip, ticker, name, mapping_status)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::text[])
       on conflict (cusip) do update
         set ticker = coalesce(excluded.ticker, securities.ticker),
             name = coalesce(excluded.name, securities.name),
             mapping_status = excluded.mapping_status`,
      [
        updates.map((u) => u.cusip),
        updates.map((u) => u.ticker),
        updates.map((u) => u.name),
        updates.map((u) => u.status),
      ],
    );

    for (const u of updates) {
      const previous = resolved.get(u.cusip);
      resolved.set(u.cusip, {
        cusip: u.cusip,
        ticker: u.ticker ?? previous?.ticker ?? null,
        name: u.name ?? previous?.name ?? null,
        mappingStatus: u.status,
      });
    }
  }

  return resolved;
}

/**
 * OpenFIGI-backed client. Not used by tests, which inject their own.
 * The free tier allows 25 requests/minute without an API key and more with
 * one; the key is optional and read from the environment.
 */
export function createOpenFigiClient(): OpenFigiClient {
  return {
    async mapCusips(cusips) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const apiKey = process.env.OPENFIGI_API_KEY;
      if (apiKey) headers["X-OPENFIGI-APIKEY"] = apiKey;

      const res = await fetch("https://api.openfigi.com/v3/mapping", {
        method: "POST",
        headers,
        body: JSON.stringify(
          cusips.map((c) => ({ idType: "ID_CUSIP", idValue: c })),
        ),
      });
      if (!res.ok) {
        throw new Error(`OpenFIGI HTTP ${res.status}`);
      }

      // Responses come back positionally, one entry per requested job.
      const body = (await res.json()) as Array<{
        data?: Array<{ ticker?: string; name?: string }>;
        error?: string;
      }>;

      const out = new Map<string, FigiMatch | null>();
      cusips.forEach((cusip, i) => {
        const hit = body[i]?.data?.[0];
        out.set(
          cusip,
          hit?.ticker ? { ticker: hit.ticker, name: hit.name ?? null } : null,
        );
      });
      return out;
    },
  };
}
