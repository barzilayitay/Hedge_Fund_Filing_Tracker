import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  seedPhase4,
  berkshireSlug,
  BRK_CURRENT_QUARTER,
  PERSHING_SLUG,
} from "../helpers/phase4";
import {
  getFundHoldings,
  getFundSummary,
  getFundRealtime,
  getStockInstitutional,
  getStockInsiders,
  getConfluence,
} from "@/lib/api";

let db: TestDb;
let brkSlug: string;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  await seedPhase4(db.sql);
  brkSlug = await berkshireSlug(db.sql);
});
afterAll(async () => {
  await db.close();
});

describe("get_fund_holdings", () => {
  it("returns the documented shape (zod contract) with a total_count", async () => {
    const res = await getFundHoldings(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
    });
    expect(res.fund?.slug).toBe(brkSlug);
    expect(res.quarter).toBe(BRK_CURRENT_QUARTER);
    expect(res.total_count).toBeGreaterThan(0);
    expect(res.rows.length).toBe(Math.min(res.total_count, 50));
    // zod already validated; sanity-check one enriched field.
    expect(res.rows[0]).toHaveProperty("market_value");
  });

  it("sorts by market_value desc matching a raw ORDER BY ground truth", async () => {
    const res = await getFundHoldings(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
      sortCol: "market_value",
      sortDir: "desc",
      pageSize: 500,
    });
    const truth = await db.query<{ cusip: string }>(
      `select cusip from fund_holdings_enriched
        where cik = (select cik from filers where slug = $1)
          and period_of_report = $2
          and position_status is not null
        order by market_value desc nulls last, cusip asc`,
      [brkSlug, BRK_CURRENT_QUARTER],
    );
    expect(res.rows.map((r) => r.cusip)).toEqual(truth.map((t) => t.cusip));
  });

  it("paginates: page 2 of size 10 returns rows 11-20 of the sorted set", async () => {
    const all = await getFundHoldings(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
      pageSize: 500,
    });
    expect(all.total_count).toBeGreaterThan(20);

    const page2 = await getFundHoldings(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
      page: 2,
      pageSize: 10,
    });
    expect(page2.total_count).toBe(all.total_count);
    expect(page2.rows).toHaveLength(10);
    expect(page2.rows.map((r) => r.cusip)).toEqual(
      all.rows.slice(10, 20).map((r) => r.cusip),
    );
  });

  it("filters by search on ticker/name", async () => {
    const res = await getFundHoldings(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
      pageSize: 500,
      search: "AAPL",
    });
    expect(res.total_count).toBeGreaterThanOrEqual(1);
    expect(
      res.rows.every(
        (r) => r.ticker === "AAPL" || (r.name ?? "").toUpperCase().includes("AAPL"),
      ),
    ).toBe(true);
  });

  it("rejects an invalid sort_col with a clean error, not a 500", async () => {
    await expect(
      getFundHoldings(db.sql, {
        fundSlug: brkSlug,
        quarter: BRK_CURRENT_QUARTER,
        sortCol: "market_value; drop table filings",
      }),
    ).rejects.toThrow(/invalid sort_col/i);
  });

  it("rejects an invalid sort_dir with a clean error", async () => {
    await expect(
      getFundHoldings(db.sql, {
        fundSlug: brkSlug,
        quarter: BRK_CURRENT_QUARTER,
        sortDir: "desc; drop table filings" as never,
      }),
    ).rejects.toThrow(/invalid sort_dir/i);
  });

  it("enforces the 500-row page-size cap server-side", async () => {
    // Ask for a huge page; the RPC must clamp to 500, never return more.
    const res = await getFundHoldings(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
      pageSize: 100000,
    });
    expect(res.rows.length).toBeLessThanOrEqual(500);
    expect(res.rows.length).toBe(Math.min(res.total_count, 500));
  });

  it("clamps an enormous page instead of raising an integer-overflow error", async () => {
    // page * page_size must not overflow int4 (would be SQLSTATE 22003). A huge
    // page simply yields an empty result set, cleanly.
    const res = await getFundHoldings(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
      page: 2147483647,
      pageSize: 500,
    });
    expect(res.total_count).toBeGreaterThan(0);
    expect(res.rows).toEqual([]);
  });

  it("total_count is filter-aware (reflects the search, not the table total)", async () => {
    const unfiltered = await getFundHoldings(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
      pageSize: 500,
    });
    const filtered = await getFundHoldings(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
      pageSize: 500,
      search: "AAPL",
    });
    expect(unfiltered.total_count).toBeGreaterThan(1);
    expect(filtered.total_count).toBeGreaterThanOrEqual(1);
    // The filter must shrink the count, and it must equal the rows returned.
    expect(filtered.total_count).toBeLessThan(unfiltered.total_count);
    expect(filtered.total_count).toBe(filtered.rows.length);
  });

  it("returns an empty, well-formed result for an unknown fund", async () => {
    const res = await getFundHoldings(db.sql, {
      fundSlug: "no-such-fund",
      quarter: BRK_CURRENT_QUARTER,
    });
    expect(res.fund).toBeNull();
    expect(res.total_count).toBe(0);
    expect(res.rows).toEqual([]);
  });
});

describe("get_fund_summary", () => {
  it("returns the summary row plus the available-quarters list", async () => {
    const res = await getFundSummary(db.sql, brkSlug, BRK_CURRENT_QUARTER);
    expect(res.fund?.slug).toBe(brkSlug);
    expect(res.summary?.period_of_report).toBe(BRK_CURRENT_QUARTER);
    expect(res.summary?.num_holdings).toBeGreaterThan(0);
    expect(res.quarters).toContain(BRK_CURRENT_QUARTER);
    // quarters are newest-first.
    expect([...res.quarters].sort().reverse()).toEqual(res.quarters);
  });

  it("defaults to the latest quarter when none is given", async () => {
    const res = await getFundSummary(db.sql, brkSlug, null);
    expect(res.quarter).toBe(BRK_CURRENT_QUARTER);
    expect(res.summary?.period_of_report).toBe(BRK_CURRENT_QUARTER);
  });
});

describe("get_fund_realtime", () => {
  it("returns the Form 4 feed for a 10%-owner fund", async () => {
    const res = await getFundRealtime(db.sql, PERSHING_SLUG);
    expect(res.fund?.slug).toBe(PERSHING_SLUG);
    expect(res.rows.length).toBeGreaterThanOrEqual(1);
    // The joint filing is on Howard Hughes Holdings.
    expect(res.rows.every((r) => r.company_cik === "0001981792")).toBe(true);
    expect(res.rows.every((r) => r.fund_slug === PERSHING_SLUG)).toBe(true);
  });

  it("is empty for a fund that files no Form 4s", async () => {
    const res = await getFundRealtime(db.sql, brkSlug);
    expect(res.fund?.slug).toBe(brkSlug);
    expect(res.rows).toEqual([]);
  });
});

describe("get_stock_institutional", () => {
  it("lists funds holding a ticker with their position changes", async () => {
    const res = await getStockInstitutional(db.sql, "AAPL", BRK_CURRENT_QUARTER);
    expect(res.ticker).toBe("AAPL");
    expect(res.total_count).toBeGreaterThanOrEqual(1);
    const brk = res.rows.find((r) => r.fund_slug === brkSlug);
    expect(brk).toBeDefined();
    expect(brk?.market_value).toBeGreaterThan(0);
    expect(["NEW", "ADDED", "REDUCED", "UNCHANGED"]).toContain(
      brk?.position_status,
    );
  });

  it("paginates with a stable total_count and clamps an oversized page_size", async () => {
    const all = await getStockInstitutional(db.sql, "AAPL", BRK_CURRENT_QUARTER, 1, 500);
    expect(all.total_count).toBeGreaterThanOrEqual(1);

    // First page of size 1 returns 1 row, total_count unchanged.
    const p1 = await getStockInstitutional(db.sql, "AAPL", BRK_CURRENT_QUARTER, 1, 1);
    expect(p1.total_count).toBe(all.total_count);
    expect(p1.rows).toHaveLength(Math.min(all.total_count, 1));

    // Oversized page_size clamps to the 500 cap.
    const big = await getStockInstitutional(
      db.sql,
      "AAPL",
      BRK_CURRENT_QUARTER,
      1,
      100000,
    );
    expect(big.rows.length).toBeLessThanOrEqual(500);
    expect(big.rows.length).toBe(Math.min(big.total_count, 500));

    // A page past the end is empty but keeps the total.
    const past = await getStockInstitutional(
      db.sql,
      "AAPL",
      BRK_CURRENT_QUARTER,
      all.total_count + 5,
      1,
    );
    expect(past.total_count).toBe(all.total_count);
    expect(past.rows).toEqual([]);
  });
});

describe("get_stock_insiders", () => {
  it("returns Form 4 rows, sentiment, and a cluster flag for a ticker", async () => {
    const res = await getStockInsiders(db.sql, "AAPL");
    expect(res.ticker).toBe("AAPL");
    expect(res.company_cik).toBe("0000320193");
    expect(res.total_count).toBeGreaterThan(0);
    expect(res.rows.every((r) => r.company_cik === "0000320193")).toBe(true);
    expect(typeof res.has_active_cluster).toBe("boolean");
    // sentiment is nullable but, if present, is for this issuer.
    if (res.sentiment) expect(res.sentiment.company_cik).toBe("0000320193");
  });

  it("paginates the insider rows", async () => {
    const all = await getStockInsiders(db.sql, "AAPL", 1, 500);
    if (all.total_count > 2) {
      const p1 = await getStockInsiders(db.sql, "AAPL", 1, 2);
      const p2 = await getStockInsiders(db.sql, "AAPL", 2, 2);
      expect(p1.rows).toHaveLength(2);
      expect(p1.total_count).toBe(all.total_count);
      // Disjoint pages.
      const key = (r: {
        accession_no: string;
        insider_cik: string;
        table_type: string;
        row_index: number;
      }) => `${r.accession_no}:${r.insider_cik}:${r.table_type}:${r.row_index}`;
      const p1keys = new Set(p1.rows.map(key));
      expect(p2.rows.some((r) => p1keys.has(key(r)))).toBe(false);
    }
  });

  it("filters by transaction code", async () => {
    const codes = ["S"];
    const res = await getStockInsiders(db.sql, "AAPL", 1, 500, codes);
    expect(res.rows.every((r) => r.transaction_code === "S")).toBe(true);
  });

  it("returns an empty, well-formed result for an unknown ticker", async () => {
    const res = await getStockInsiders(db.sql, "ZZZZ");
    expect(res.company_cik).toBeNull();
    expect(res.total_count).toBe(0);
    expect(res.rows).toEqual([]);
    expect(res.has_active_cluster).toBe(false);
  });
});

describe("get_confluence", () => {
  it("returns per-quarter institutional change and insider transactions", async () => {
    const res = await getConfluence(db.sql, "AAPL", "2025-12-31");
    expect(res.ticker).toBe("AAPL");
    expect(res.from_quarter).toBe("2025-12-31");
    // Berkshire holds AAPL across the loaded quarters.
    expect(res.institutional.length).toBeGreaterThanOrEqual(1);
    expect(res.institutional.every((q) => q.quarter >= "2025-12-31")).toBe(true);
    // Apple Form 4s (P/S) on/after the from_quarter.
    expect(
      res.insiders.every(
        (t) =>
          (t.transaction_code === "P" || t.transaction_code === "S") &&
          t.transaction_date >= "2025-12-31",
      ),
    ).toBe(true);
  });
});
