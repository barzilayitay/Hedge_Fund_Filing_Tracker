/**
 * Seed a local database with every committed fixture, so `npm run dev` shows
 * realistic data. Production-style script (like load-prices / load-companyfacts):
 * it talks to a real Postgres via makeProductionSql and is NOT run by tests
 * (hard rule 2 — tests never hit a live DB path; they seed via helpers on PGlite).
 *
 *   DATABASE_URL=postgres://... npm run seed
 *
 * Loads, in order:
 *   1. companies      (company_tickers.json)
 *   2. securities     (spotcheck-securities.json, the resolved cusip->ticker
 *      cache; every other CUSIP a filing mentions lands 'unmapped' via load13f)
 *   3. shares_outstanding (committed companyfacts fixtures)
 *   4. quarterly_prices   (committed CSV)
 *   5. every 13F fixture  (load13f)
 *   6. every Form 4 fixture (loadForm4)
 *   7. refresh_derived()
 *
 * Idempotent: every loader upserts, so re-running is safe.
 *
 * SAFETY: this writes to whatever DATABASE_URL points at. To honor hard rule 4
 * ("never touch production"), it refuses to run unless the DATABASE_URL host is
 * localhost / 127.0.0.1, unless the operator passes --i-know-what-im-doing.
 */
import { readFileSync } from "fs";
import { join } from "path";
import type { Sql } from "../lib/db/sql";
import { makeProductionSql } from "./prod-sql";
import { seedCompanies } from "../lib/edgar/cusipMap";
import { parse13f } from "../lib/edgar/parse13f";
import { parseForm4 } from "../lib/edgar/parseForm4";
import { load13f } from "../lib/edgar/load13f";
import { loadForm4 } from "../lib/edgar/loadForm4";
import { parsePricesCsv } from "../lib/analytics/prices";
import { upsertQuarterlyPrices } from "./load-prices";
import { loadCompanyfactsFromFixtures } from "./load-companyfacts";

const ROOT = join(__dirname, "..");
const FIXTURES = join(ROOT, "fixtures");
const F13F = join(FIXTURES, "13f");
const FORM4 = join(FIXTURES, "form4");
const REFERENCE = join(FIXTURES, "reference");
const PRICES = join(FIXTURES, "prices");
const COMPANYFACTS = join(FIXTURES, "companyfacts");

interface Manifest13fEntry {
  label: string;
  accession: string;
  filedAt: string;
  coverPage: string;
  informationTable: string;
}

interface ManifestForm4Entry {
  label: string;
  accession: string;
  filedAt: string;
}

interface SpotcheckSecurity {
  cusip: string;
  ticker: string;
  sector: string;
  name: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

async function seedSpotcheckSecurities(sql: Sql): Promise<number> {
  const rows = readJson<SpotcheckSecurity[]>(
    join(REFERENCE, "spotcheck-securities.json"),
  );
  await sql.query(
    `insert into securities (cusip, ticker, name, sector, mapping_status)
     select cusip, ticker, name, sector, 'mapped'
       from unnest($1::text[], $2::text[], $3::text[], $4::text[])
         as t(cusip, ticker, name, sector)
     on conflict (cusip) do update
       set ticker = excluded.ticker, name = excluded.name,
           sector = excluded.sector, mapping_status = 'mapped'`,
    [
      rows.map((s) => s.cusip),
      rows.map((s) => s.ticker),
      rows.map((s) => s.name),
      rows.map((s) => s.sector),
    ],
  );
  return rows.length;
}

async function seedAll(sql: Sql): Promise<void> {
  const companies = await seedCompanies(
    sql,
    readFileSync(join(REFERENCE, "company_tickers.json"), "utf-8"),
  );
  console.log(`companies: ${companies}`);

  const securities = await seedSpotcheckSecurities(sql);
  console.log(`securities (mapped cache): ${securities}`);

  const facts = await loadCompanyfactsFromFixtures(sql, COMPANYFACTS);
  console.log(`shares_outstanding: ${facts}`);

  const prices = await upsertQuarterlyPrices(
    sql,
    parsePricesCsv(readFileSync(join(PRICES, "quarterly_prices.csv"), "utf-8")),
  );
  console.log(`quarterly_prices: ${prices}`);

  const m13f = readJson<Manifest13fEntry[]>(join(F13F, "manifest.json"));
  for (const e of m13f) {
    const parsed = parse13f(
      readFileSync(join(F13F, e.coverPage), "utf-8"),
      readFileSync(join(F13F, e.informationTable), "utf-8"),
      { accessionNo: e.accession, filedAt: e.filedAt },
    );
    const res = await load13f(sql, parsed);
    console.log(`13F ${e.label}: ${res.holdingsLoaded} holdings`);
  }

  const mForm4 = readJson<ManifestForm4Entry[]>(join(FORM4, "manifest.json"));
  for (const e of mForm4) {
    const parsed = parseForm4(readFileSync(join(FORM4, `${e.label}.xml`), "utf-8"), {
      accessionNo: e.accession,
      filedAt: e.filedAt,
    });
    const res = await loadForm4(sql, parsed);
    console.log(`Form 4 ${e.label}: ${res.transactionsLoaded} transactions`);
  }

  await sql.query("select refresh_derived()");
  console.log("refresh_derived() complete");
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Guard against seeding a non-local database. Returns nothing on success;
 * throws with an explanatory message when the target is not local and the
 * override flag is absent.
 */
export function assertLocalTarget(
  databaseUrl: string | undefined,
  argv: readonly string[],
): void {
  const override = argv.includes("--i-know-what-im-doing");
  if (override) return;
  if (!databaseUrl) {
    // No URL: makeProductionSql will throw its own clear error; nothing to guard.
    return;
  }
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error(
      `seed-dev: DATABASE_URL is not a valid URL; refusing to run. ` +
        `Pass --i-know-what-im-doing to override.`,
    );
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `seed-dev: refusing to seed a non-local database (host "${host}"). ` +
        `This script writes fixtures and must never touch production ` +
        `(CLAUDE.md hard rule 4). Point DATABASE_URL at localhost, or pass ` +
        `--i-know-what-im-doing if you really mean to seed "${host}".`,
    );
  }
}

async function main(): Promise<void> {
  assertLocalTarget(process.env.DATABASE_URL, process.argv.slice(2));
  const { sql, close } = await makeProductionSql();
  try {
    await seedAll(sql);
    console.log("seed-dev: done");
  } finally {
    await close();
  }
}

// Only run when invoked directly (npm run seed), not when imported by a test
// that exercises assertLocalTarget.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
