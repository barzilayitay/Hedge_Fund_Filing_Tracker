/**
 * Production price loader: fetch quarter-end closes from a free provider and
 * upsert them into quarterly_prices. Not exercised by tests (hard rule 2); the
 * committed fixture seed is fixtures/prices/quarterly_prices.csv.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/load-prices.ts <ticker...>
 *
 * With no tickers it refreshes every ticker already in quarterly_prices.
 */
import type { Sql } from "../lib/db/sql";
import { pickQuarterEndCloses, type QuarterEndPrice } from "../lib/analytics/prices";
import { fetchYahooDailyCloses } from "./providers";

/** Idempotent upsert on (ticker, quarter_end). */
export async function upsertQuarterlyPrices(
  sql: Sql,
  rows: QuarterEndPrice[],
): Promise<number> {
  if (rows.length === 0) return 0;
  await sql.query(
    `insert into quarterly_prices (ticker, quarter_end, close_price)
     select * from unnest($1::text[], $2::date[], $3::numeric[])
     on conflict (ticker, quarter_end) do update
       set close_price = excluded.close_price`,
    [
      rows.map((r) => r.ticker),
      rows.map((r) => r.quarterEnd),
      rows.map((r) => r.closePrice),
    ],
  );
  return rows.length;
}

/** Fetch quarter-end closes for the given tickers/quarters from the provider. */
export async function fetchQuarterEndPrices(
  tickers: string[],
  quarterEnds: string[],
): Promise<QuarterEndPrice[]> {
  const sorted = [...quarterEnds].sort();
  const start = new Date(sorted[0]);
  start.setUTCDate(start.getUTCDate() - 14);
  const startISO = start.toISOString().slice(0, 10);
  const endISO = sorted[sorted.length - 1];

  const out: QuarterEndPrice[] = [];
  for (const ticker of tickers) {
    try {
      const series = await fetchYahooDailyCloses(ticker, startISO, endISO);
      out.push(...pickQuarterEndCloses(ticker, series, sorted));
    } catch (e) {
      console.error(`  ${ticker} failed: ${(e as Error).message}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { makeProductionSql } = await import("./prod-sql");
  const { sql, close } = await makeProductionSql();
  try {
    const argTickers = process.argv.slice(2);
    const tickers =
      argTickers.length > 0
        ? argTickers
        : (
            await sql.query<{ ticker: string }>(
              `select distinct ticker from quarterly_prices order by ticker`,
            )
          ).map((r) => r.ticker);
    const quarters = (
      await sql.query<{ q: string }>(
        `select distinct to_char(quarter_end, 'YYYY-MM-DD') as q
           from quarterly_prices order by q`,
      )
    ).map((r) => r.q);

    if (tickers.length === 0 || quarters.length === 0) {
      console.error("No tickers/quarters to refresh. Seed quarterly_prices first.");
      return;
    }
    const rows = await fetchQuarterEndPrices(tickers, quarters);
    const n = await upsertQuarterlyPrices(sql, rows);
    console.log(`Upserted ${n} price rows for ${tickers.length} tickers.`);
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
