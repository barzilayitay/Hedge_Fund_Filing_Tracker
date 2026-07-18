import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedPhase2 } from "../helpers/phase2";
import { readDiffExpected } from "../helpers/fixtures";

let db: TestDb;
const expected = readDiffExpected();
const CUR = expected.period_of_report; // 2026-03-31
const PRIOR = expected.prior_period; // 2025-12-31
const BRK = expected.cik;

beforeAll(async () => {
  db = await createTestDb();
  await seedPhase2(db.sql);
}, 60_000);

afterAll(async () => {
  await db.close();
});

/** Numeric columns come back from Postgres as strings; null stays null. */
function num(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

interface EnrichedRow {
  cusip: string;
  ticker: string | null;
  sector: string | null;
  put_call: string | null;
  share_class: string | null;
  position_status: string;
  shares: string | null;
  market_value: string;
  prior_market_value: string;
  pct_of_portfolio: string | null;
  prior_pct_of_portfolio: string | null;
  rank: number | null;
  change_in_shares: string | null;
  pct_change: string | null;
  pct_ownership: string | null;
  qtr_first_owned: string | null;
  est_avg_price: string | null;
  quarter_end_price: string | null;
}

async function enrichedFor(period: string): Promise<Map<string, EnrichedRow>> {
  const rows = await db.query<EnrichedRow>(
    `select cusip, ticker, sector, put_call, share_class, position_status,
            shares::text, market_value::text, prior_market_value::text,
            pct_of_portfolio::text, prior_pct_of_portfolio::text, rank,
            change_in_shares::text, pct_change::text, pct_ownership::text,
            qtr_first_owned::text, est_avg_price::text, quarter_end_price::text
       from fund_holdings_enriched where cik = $1 and period_of_report = $2`,
    [BRK, period],
  );
  const map = new Map<string, EnrichedRow>();
  for (const r of rows) {
    map.set(`${r.cusip}|${r.put_call ?? ""}|${r.share_class ?? ""}`, r);
  }
  return map;
}

describe("fund_holdings_enriched", () => {
  it("matches all 8 hand-computed positions on every column", async () => {
    const rows = await enrichedFor(CUR);

    for (const pos of expected.positions) {
      const key = `${pos.cusip}|${pos.put_call ?? ""}|${pos.share_class ?? ""}`;
      const row = rows.get(key);
      expect(row, `missing enriched row for ${pos.ticker} (${key})`).toBeTruthy();
      if (!row) continue;
      const label = String(pos.ticker);

      expect(row.ticker, `${label} ticker`).toBe(pos.ticker);
      expect(row.position_status, `${label} status`).toBe(pos.position_status);
      expect(row.qtr_first_owned, `${label} qtr_first_owned`).toBe(pos.qtr_first_owned);
      expect(row.rank, `${label} rank`).toBe(pos.rank);

      // Exact-integer columns.
      for (const col of ["shares", "market_value", "prior_market_value", "change_in_shares"] as const) {
        expect(num(row[col]), `${label} ${col}`).toBe(pos[col] as number | null);
      }
      // 4-decimal columns (view rounds to 6; assert to 4).
      for (const col of [
        "pct_of_portfolio",
        "prior_pct_of_portfolio",
        "pct_change",
        "pct_ownership",
        "est_avg_price",
        "quarter_end_price",
      ] as const) {
        const want = pos[col] as number | null;
        const got = num(row[col]);
        if (want === null) expect(got, `${label} ${col} should be null`).toBeNull();
        else expect(got, `${label} ${col}`).toBeCloseTo(want, 4);
      }
    }
  });

  it("yields all-NEW statuses and null prior_pct for a first quarter", async () => {
    const rows = await enrichedFor(PRIOR);
    expect(rows.size).toBeGreaterThan(0);
    for (const r of rows.values()) {
      expect(r.position_status, `${r.cusip} status`).toBe("NEW");
      expect(r.prior_pct_of_portfolio, `${r.cusip} prior_pct`).toBeNull();
      expect(num(r.prior_market_value)).toBe(0);
      expect(r.pct_change, `${r.cusip} pct_change`).toBeNull();
    }
  });

  it("shows an unmapped CUSIP with null ticker/sector and correct pct_of_portfolio", async () => {
    const rows = [...(await enrichedFor(CUR)).values()]
      .filter((r) => r.ticker === null && r.position_status !== "SOLD_OUT")
      .sort((a, b) => Number(b.market_value) - Number(a.market_value));
    expect(rows.length, "expected at least one unmapped current holding").toBeGreaterThan(0);

    const r = rows[0];
    expect(r.sector).toBeNull();
    expect(num(r.est_avg_price)).toBeNull();
    expect(num(r.quarter_end_price)).toBeNull();
    // pct_of_portfolio still correct despite being unmapped.
    const pv = expected.portfolio_value;
    expect(num(r.pct_of_portfolio)).toBeCloseTo((100 * Number(r.market_value)) / pv, 4);
  });

  it("refresh_derived() completes well under 10s", async () => {
    const start = Date.now();
    await db.query("select refresh_derived()");
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});

describe("fund_quarter_summary", () => {
  interface SummaryRow {
    portfolio_value: string;
    num_holdings: number;
    top10_concentration_pct: string;
    turnover_pct: string | null;
    sector_allocation: Record<string, number>;
    top_new_buys: Array<Record<string, unknown>>;
    top_sells: Array<Record<string, unknown>>;
  }

  async function summaryFor(period: string): Promise<SummaryRow> {
    const [row] = await db.query<SummaryRow>(
      `select portfolio_value::text, num_holdings,
              top10_concentration_pct::text, turnover_pct::text,
              sector_allocation, top_new_buys, top_sells
         from fund_quarter_summary where cik = $1 and period_of_report = $2`,
      [BRK, period],
    );
    return row;
  }

  it("matches expected summary numbers for the current quarter", async () => {
    const s = await summaryFor(CUR);
    const e = expected.summary.current;

    expect(num(s.portfolio_value)).toBe(e.portfolio_value);
    expect(s.num_holdings).toBe(e.num_holdings);
    expect(num(s.top10_concentration_pct)).toBeCloseTo(e.top10_concentration_pct as number, 4);
    expect(num(s.turnover_pct)).toBeCloseTo(e.turnover_pct as number, 4);

    const expSectors = e.sector_allocation as Record<string, number>;
    expect(Object.keys(s.sector_allocation).sort()).toEqual(Object.keys(expSectors).sort());
    for (const [sec, pct] of Object.entries(expSectors)) {
      expect(Number(s.sector_allocation[sec]), `sector ${sec}`).toBeCloseTo(pct, 4);
    }

    const expBuys = e.top_new_buys as Array<Record<string, unknown>>;
    expect(s.top_new_buys.map((b) => b.ticker)).toEqual(expBuys.map((b) => b.ticker));
    s.top_new_buys.forEach((b, i) => {
      expect(b.cusip).toBe(expBuys[i].cusip);
      expect(Number(b.market_value)).toBe(expBuys[i].market_value);
    });

    const expSells = e.top_sells as Array<Record<string, unknown>>;
    expect(s.top_sells.map((b) => b.ticker)).toEqual(expSells.map((b) => b.ticker));
    s.top_sells.forEach((b, i) => {
      expect(b.cusip).toBe(expSells[i].cusip);
      expect(b.position_status).toBe(expSells[i].position_status);
      expect(Number(b.value_dropped)).toBeCloseTo(expSells[i].value_dropped as number, 4);
    });
  });

  it("has no turnover and all-NEW buys for the first quarter", async () => {
    const s = await summaryFor(PRIOR);
    const e = expected.summary.prior;
    expect(num(s.portfolio_value)).toBe(e.portfolio_value);
    expect(s.num_holdings).toBe(e.num_holdings);
    expect(num(s.top10_concentration_pct)).toBeCloseTo(e.top10_concentration_pct as number, 4);
    expect(s.turnover_pct).toBeNull();
    expect(s.top_sells).toEqual([]);
  });
});
