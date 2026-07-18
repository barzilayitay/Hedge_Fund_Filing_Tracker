import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { load13f } from "@/lib/edgar/load13f";
import { parse13f } from "@/lib/edgar/parse13f";
import { createTestDb, type TestDb } from "../helpers/db";
import { parseFixture, readExpected } from "../helpers/fixtures";

/**
 * Amendment semantics must survive into the Phase 2 aggregation, not just into
 * Phase 1's filings_effective view. These tests load real amendment pairs and
 * assert on holdings_13f_agg (and fund_holdings_enriched after refresh).
 *
 * Every expected value is hand-computed from the fixture expected.json files
 * (the filer's own declared totals, cross-checked in Phase 1), NEVER read back
 * from the view under test.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
});
afterAll(async () => {
  await db.close();
});

const n = (v: unknown): number => Number(v);

async function aggTotal(cik: string, period: string): Promise<number> {
  const [row] = await db.query<{ total: string }>(
    `select coalesce(sum(value_usd), 0)::text as total
       from holdings_13f_agg where cik = $1 and period_of_report = $2`,
    [cik, period],
  );
  return n(row.total);
}

async function aggPositionCount(cik: string, period: string): Promise<number> {
  const [row] = await db.query<{ c: string }>(
    `select count(*)::text as c
       from holdings_13f_agg where cik = $1 and period_of_report = $2`,
    [cik, period],
  );
  return n(row.c);
}

describe("RESTATEMENT flows through holdings_13f_agg", () => {
  const ORIGINAL = "gfi-restatement-original-2025-02-12";
  const AMENDMENT = "gfi-restatement-amendment-2025-06-10";
  const CIK = "0001688774";
  const PERIOD = "2024-12-31";

  it("aggregates the /A only — the superseded original never contributes", async () => {
    await load13f(db.sql, parseFixture(ORIGINAL));
    await load13f(db.sql, parseFixture(AMENDMENT));

    const original = readExpected(ORIGINAL); // total 871,073 ($ thousands era)
    const amendment = readExpected(AMENDMENT); // total 871,072,606 (whole USD)

    // The /A restates $ thousands to whole dollars, so a wrong answer is off by
    // ~1000x, not a rounding error. holdings_13f_agg must show ONLY the /A.
    expect(await aggTotal(CIK, PERIOD)).toBe(amendment.totalValueUsd);
    expect(await aggTotal(CIK, PERIOD)).not.toBe(original.totalValueUsd);
    expect(await aggTotal(CIK, PERIOD)).not.toBe(
      original.totalValueUsd + amendment.totalValueUsd,
    );

    // GFI reports one row per security, all distinct CUSIPs, put_call null, so
    // the number of aggregated positions equals the /A row count.
    expect(await aggPositionCount(CIK, PERIOD)).toBe(amendment.rowCount);

    // A spot-check position carries the /A's (restated) value, not the original.
    const axp = amendment.spotChecks.find((s) => s.cusip === "025816109");
    expect(axp).toBeTruthy();
    const [row] = await db.query<{ value_usd: string; shares: string }>(
      `select value_usd::text, shares::text from holdings_13f_agg
        where cik = $1 and period_of_report = $2
          and cusip = '025816109' and put_call is null and share_class = 'COM'`,
      [CIK, PERIOD],
    );
    expect(n(row.value_usd)).toBe(axp!.valueUsd);
    expect(n(row.shares)).toBe(axp!.shares);
  });

  it("carries the supersession into fund_holdings_enriched after refresh", async () => {
    await load13f(db.sql, parseFixture(ORIGINAL));
    await load13f(db.sql, parseFixture(AMENDMENT));
    await db.query("select refresh_derived()");

    const amendment = readExpected(AMENDMENT);
    const [sum] = await db.query<{ total: string }>(
      `select coalesce(sum(market_value), 0)::text as total
         from fund_holdings_enriched
        where cik = $1 and period_of_report = $2 and position_status <> 'SOLD_OUT'`,
      [CIK, PERIOD],
    );
    expect(n(sum.total)).toBe(amendment.totalValueUsd);
    expect(n(sum.total)).not.toBe(readExpected(ORIGINAL).totalValueUsd);
  });
});

describe("NEW HOLDINGS unions through holdings_13f_agg", () => {
  const ORIGINAL = "brk-newholdings-original-2024-02-14";
  const AMENDMENT = "brk-newholdings-amendment-2024-05-15";
  const CIK = "0001067983";
  const PERIOD = "2023-12-31";

  it("aggregates the original's rows UNIONed with the /A's", async () => {
    await load13f(db.sql, parseFixture(ORIGINAL));
    await load13f(db.sql, parseFixture(AMENDMENT));

    const original = readExpected(ORIGINAL); // 138 rows, 41 CUSIPs
    const amendment = readExpected(AMENDMENT); // 1 row: Chubb (H1467J104)

    // Both filings stay effective, so the aggregate value is the sum of both.
    expect(await aggTotal(CIK, PERIOD)).toBe(
      original.totalValueUsd + amendment.totalValueUsd,
    );

    // The /A discloses exactly one previously-confidential CUSIP, absent from
    // the original, so distinct-CUSIP count grows by exactly one.
    const [distinct] = await db.query<{ c: string }>(
      `select count(distinct cusip)::text as c
         from holdings_13f_agg where cik = $1 and period_of_report = $2`,
      [CIK, PERIOD],
    );
    expect(n(distinct.c)).toBe(original.distinctCusips + 1);
  });

  it("keeps the previously-confidential position as one aggregate row from the /A", async () => {
    await load13f(db.sql, parseFixture(ORIGINAL));
    await load13f(db.sql, parseFixture(AMENDMENT));

    const chubb = readExpected(AMENDMENT).spotChecks[0]; // H1467J104
    const rows = await db.query<{ value_usd: string; shares: string }>(
      `select value_usd::text, shares::text from holdings_13f_agg
        where cik = $1 and period_of_report = $2 and cusip = $3`,
      [CIK, PERIOD, chubb.cusip],
    );
    expect(rows).toHaveLength(1);
    expect(n(rows[0].value_usd)).toBe(chubb.valueUsd);
    expect(n(rows[0].shares)).toBe(chubb.shares);
    // The /A is the sole source of this holding.
    expect(chubb.valueUsd).toBe(readExpected(AMENDMENT).totalValueUsd);
  });
});

describe("put/call positions stay distinct through the analytics", () => {
  const FIX_DIR = join(__dirname, "fixtures");
  const CIK = "0009999999";
  const PERIOD = "2026-03-31";
  const CUSIP = "SYNTH0001";

  function loadSynthetic(): Promise<unknown> {
    const cover = readFileSync(join(FIX_DIR, "synthetic-putcall.cover.xml"), "utf-8");
    const info = readFileSync(join(FIX_DIR, "synthetic-putcall.xml"), "utf-8");
    const parsed = parse13f(cover, info, {
      accessionNo: "9999999999-99-999999",
      filedAt: "2026-05-15",
    });
    return load13f(db.sql, parsed);
  }

  it("holdings_13f_agg keeps equity, put and call as three separate positions", async () => {
    await loadSynthetic();

    const rows = await db.query<{
      put_call: string | null;
      shares: string;
      value_usd: string;
      row_count: string;
    }>(
      `select put_call, shares::text, value_usd::text, row_count::text
         from holdings_13f_agg
        where cik = $1 and period_of_report = $2 and cusip = $3
        order by put_call nulls first`,
      [CIK, PERIOD, CUSIP],
    );

    expect(rows).toHaveLength(3);
    const byKey = new Map(rows.map((r) => [r.put_call ?? "EQUITY", r]));

    // The two equity rows (different otherManager) are SUMmed into one position;
    // the put and call are never merged in.
    expect(n(byKey.get("EQUITY")!.shares)).toBe(1500);
    expect(n(byKey.get("EQUITY")!.value_usd)).toBe(150000);
    expect(n(byKey.get("EQUITY")!.row_count)).toBe(2);

    expect(n(byKey.get("Put")!.shares)).toBe(200);
    expect(n(byKey.get("Put")!.value_usd)).toBe(20000);
    expect(n(byKey.get("Put")!.row_count)).toBe(1);

    expect(n(byKey.get("Call")!.shares)).toBe(300);
    expect(n(byKey.get("Call")!.value_usd)).toBe(30000);
    expect(n(byKey.get("Call")!.row_count)).toBe(1);
  });

  it("fund_holdings_enriched diffs them as three rows, never merged", async () => {
    await loadSynthetic();
    await db.query("select refresh_derived()");

    const rows = await db.query<{
      put_call: string | null;
      market_value: string;
      position_status: string;
    }>(
      `select put_call, market_value::text, position_status
         from fund_holdings_enriched
        where cik = $1 and period_of_report = $2 and cusip = $3
        order by put_call nulls first`,
      [CIK, PERIOD, CUSIP],
    );

    expect(rows).toHaveLength(3);
    const byKey = new Map(rows.map((r) => [r.put_call ?? "EQUITY", r]));
    expect(n(byKey.get("EQUITY")!.market_value)).toBe(150000);
    expect(n(byKey.get("Put")!.market_value)).toBe(20000);
    expect(n(byKey.get("Call")!.market_value)).toBe(30000);
    // Single quarter loaded, so each is a NEW position (proves the diff join
    // matched put→put / call→call and did not collapse them onto the equity row).
    for (const r of rows) expect(r.position_status).toBe("NEW");
  });
});
