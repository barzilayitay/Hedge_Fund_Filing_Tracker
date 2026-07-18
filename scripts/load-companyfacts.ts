/**
 * Populate companies.shares_outstanding from SEC companyfacts.
 *
 * By default it reads the committed fixtures in fixtures/companyfacts/ (offline,
 * the source Phase 2 tests use). With --live it refetches from SEC through the
 * rate-limited client for the CIKs already in `companies`. Writing to the DB
 * needs DATABASE_URL (+ `pg`); the production Sql adapter lands in Phase 4/6.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/load-companyfacts.ts
 *   DATABASE_URL=postgres://... EDGAR_USER_AGENT="App you@x.com" \
 *     npx tsx scripts/load-companyfacts.ts --live
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Sql } from "../lib/db/sql";
import { pickSharesOutstanding } from "../lib/analytics/companyfacts";

const FIXTURE_DIR = join(__dirname, "..", "fixtures", "companyfacts");

/** Update one company's shares_outstanding from its companyfacts document. */
export async function loadSharesOutstanding(
  sql: Sql,
  cik: string,
  doc: unknown,
): Promise<boolean> {
  const so = pickSharesOutstanding(doc);
  if (!so) return false;
  await sql.query(
    `update companies
        set shares_outstanding = $2, shares_outstanding_asof = $3
      where cik = $1`,
    [cik, so.value, so.asof],
  );
  return true;
}

/** Load every committed companyfacts fixture (filenames like CIK0000320193.shares.json). */
export async function loadCompanyfactsFromFixtures(
  sql: Sql,
  dir: string = FIXTURE_DIR,
): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const cik = file.replace(/\.shares\.json$/, "").replace(/^CIK/, "");
    const doc = JSON.parse(readFileSync(join(dir, file), "utf-8"));
    if (await loadSharesOutstanding(sql, cik, doc)) updated++;
    else skipped++;
  }
  return { updated, skipped };
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const { makeProductionSql } = await import("./prod-sql");
  const { sql, close } = await makeProductionSql();
  try {
    if (!live) {
      const { updated, skipped } = await loadCompanyfactsFromFixtures(sql);
      console.log(`shares_outstanding: ${updated} updated, ${skipped} without a figure.`);
      return;
    }
    const { fetchSharesConcept } = await import("./providers");
    const ciks = (
      await sql.query<{ cik: string }>(
        `select cik from companies where cik is not null order by cik`,
      )
    ).map((r) => r.cik);
    let updated = 0;
    for (const cik of ciks) {
      try {
        const doc = await fetchSharesConcept(cik);
        if (await loadSharesOutstanding(sql, cik, doc)) updated++;
      } catch (e) {
        console.error(`  CIK${cik} failed: ${(e as Error).message}`);
      }
    }
    console.log(`shares_outstanding: ${updated}/${ciks.length} companies updated (live).`);
  } finally {
    await close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
