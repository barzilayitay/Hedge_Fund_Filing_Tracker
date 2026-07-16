import type { Sql } from "../db/sql";
import { reconcilePeriod } from "./amendments";
import { ensureSecurities } from "./cusipMap";
import type { Parsed13F } from "./schemas13f";

/**
 * Parsed 13F -> database rows.
 *
 * Every write is an upsert keyed on the accession number (hard rule 6), so
 * re-ingesting a filing is a no-op beyond updated_at. Amendment bookkeeping is
 * delegated to reconcilePeriod, which recomputes the filer's whole period and
 * therefore does not care what order filings arrive in.
 */

export interface LoadResult {
  accessionNo: string;
  cik: string;
  periodOfReport: string;
  holdingsLoaded: number;
  /** Accessions no longer in filings_effective after this load. */
  superseded: string[];
  warnings: string[];
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === UNIQUE_VIOLATION;
}

/**
 * Slugs are unique across filers, but two managers can normalize to the same
 * slug. Fall back to a CIK-suffixed slug rather than failing the ingest.
 */
async function upsertFiler(
  sql: Sql,
  filer: Parsed13F["filer"],
  warnings: string[],
): Promise<void> {
  const upsert = (slug: string): Promise<unknown> =>
    sql.query(
      `insert into filers (cik, name, slug) values ($1, $2, $3)
       on conflict (cik) do update
         set name = excluded.name, slug = excluded.slug`,
      [filer.cik, filer.name, slug],
    );

  try {
    await upsert(filer.slug);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const unique = `${filer.slug}-${filer.cik.slice(-4)}`;
    warnings.push(
      `slug "${filer.slug}" already belongs to another filer; using "${unique}"`,
    );
    await upsert(unique);
  }
}

async function upsertFiling(sql: Sql, parsed: Parsed13F): Promise<void> {
  const f = parsed.filing;
  // is_superseded and amends_accession_no are owned by reconcilePeriod and
  // deliberately not written here.
  await sql.query(
    `insert into filings (
       accession_no, cik, form_type, period_of_report, filed_at, amendment_type
     ) values ($1, $2, $3, $4, $5, $6)
     on conflict (accession_no) do update
       set cik = excluded.cik,
           form_type = excluded.form_type,
           period_of_report = excluded.period_of_report,
           filed_at = excluded.filed_at,
           amendment_type = excluded.amendment_type`,
    [f.accessionNo, f.cik, f.formType, f.periodOfReport, f.filedAt, f.amendmentType],
  );
}

async function upsertHoldings(sql: Sql, parsed: Parsed13F): Promise<void> {
  const rows = parsed.holdings;
  const accessionNo = parsed.filing.accessionNo;

  if (rows.length > 0) {
    await sql.query(
      `insert into holdings_13f (
         accession_no, row_index, cusip, put_call, share_class, other_manager,
         shares, principal_amt, value_usd, investment_discretion
       )
       select $1, * from unnest(
         $2::int[], $3::text[], $4::text[], $5::text[], $6::text[],
         $7::numeric[], $8::numeric[], $9::numeric[], $10::text[]
       )
       on conflict (accession_no, row_index) do update
         set cusip = excluded.cusip,
             put_call = excluded.put_call,
             share_class = excluded.share_class,
             other_manager = excluded.other_manager,
             shares = excluded.shares,
             principal_amt = excluded.principal_amt,
             value_usd = excluded.value_usd,
             investment_discretion = excluded.investment_discretion`,
      [
        accessionNo,
        rows.map((h) => h.rowIndex),
        rows.map((h) => h.cusip),
        rows.map((h) => h.putCall),
        rows.map((h) => h.shareClass),
        rows.map((h) => h.otherManager),
        rows.map((h) => h.shares),
        rows.map((h) => h.principalAmt),
        rows.map((h) => h.valueUsd),
        rows.map((h) => h.investmentDiscretion),
      ],
    );
  }

  // Drop rows left behind if this accession previously parsed to more rows.
  await sql.query(
    `delete from holdings_13f where accession_no = $1 and row_index >= $2`,
    [accessionNo, rows.length],
  );
}

/** Ingest one parsed 13F. Safe to call repeatedly with the same input. */
export async function load13f(sql: Sql, parsed: Parsed13F): Promise<LoadResult> {
  const warnings = [...parsed.warnings];

  return sql.transaction(async (tx) => {
    await upsertFiler(tx, parsed.filer, warnings);
    await upsertFiling(tx, parsed);

    // Holdings reference securities, and an unresolvable CUSIP must never
    // block ingestion, so every CUSIP gets a row up front.
    await ensureSecurities(tx, parsed.holdings.map((h) => h.cusip));
    await upsertHoldings(tx, parsed);

    const reconciled = await reconcilePeriod(
      tx,
      parsed.filing.cik,
      parsed.filing.periodOfReport,
    );
    warnings.push(...reconciled.warnings);

    return {
      accessionNo: parsed.filing.accessionNo,
      cik: parsed.filing.cik,
      periodOfReport: parsed.filing.periodOfReport,
      holdingsLoaded: parsed.holdings.length,
      superseded: reconciled.superseded,
      warnings,
    };
  });
}
