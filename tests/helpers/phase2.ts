import type { Sql } from "@/lib/db/sql";
import { load13f } from "@/lib/edgar/load13f";
import { seedCompanies } from "@/lib/edgar/cusipMap";
import { parsePricesCsv } from "@/lib/analytics/prices";
import { upsertQuarterlyPrices } from "@/scripts/load-prices";
import { loadCompanyfactsFromFixtures } from "@/scripts/load-companyfacts";
import {
  parseFixture,
  readCompanyTickersJson,
  readPricesCsv,
  readSpotcheckSecurities,
  COMPANYFACTS_DIR,
} from "./fixtures";

/**
 * Seed a test database to the state Phase 2 analytics run against, using the
 * same loaders production uses:
 *   - companies from company_tickers.json (seedCompanies), then
 *     shares_outstanding from the committed companyfacts fixtures
 *     (loadCompanyfactsFromFixtures)
 *   - securities resolved cache from spotcheck-securities.json (the CUSIPs our
 *     fixtures actually hold; everything else stays 'unmapped')
 *   - quarterly_prices from the committed CSV (upsertQuarterlyPrices)
 *   - the two consecutive Berkshire quarters loaded through load13f
 * then refreshes the materialized analytics.
 */
export async function seedPhase2(sql: Sql): Promise<void> {
  await seedCompanies(sql, readCompanyTickersJson());

  const securities = readSpotcheckSecurities();
  await sql.query(
    `insert into securities (cusip, ticker, name, sector, mapping_status)
     select cusip, ticker, name, sector, 'mapped'
       from unnest($1::text[], $2::text[], $3::text[], $4::text[])
         as t(cusip, ticker, name, sector)
     on conflict (cusip) do update
       set ticker = excluded.ticker, name = excluded.name,
           sector = excluded.sector, mapping_status = 'mapped'`,
    [
      securities.map((s) => s.cusip),
      securities.map((s) => s.ticker),
      securities.map((s) => s.name),
      securities.map((s) => s.sector),
    ],
  );

  await loadCompanyfactsFromFixtures(sql, COMPANYFACTS_DIR);
  await upsertQuarterlyPrices(sql, parsePricesCsv(readPricesCsv()));

  // Prior quarter (2025-12-31) then current (2026-03-31).
  await load13f(sql, parseFixture("brk-2026-02-17"));
  await load13f(sql, parseFixture("brk-2026-05-15"));

  await sql.query("select refresh_derived()");
}
