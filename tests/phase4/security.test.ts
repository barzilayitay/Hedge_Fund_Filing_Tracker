import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedPhase4, berkshireSlug, BRK_CURRENT_QUARTER } from "../helpers/phase4";
import { getFundHoldings } from "@/lib/api";

/**
 * RLS / grant model: the anon role reaches data ONLY through the RPCs and the
 * whitelisted derived views, never a base table directly. The RPCs are
 * security definer (owned by the migration role, which owns the tables), so
 * they still read the data on anon's behalf.
 */

let db: TestDb;
let brkSlug: string;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
  await seedPhase4(db.sql); // seeded as the owner (postgres), before dropping to anon
  brkSlug = await berkshireSlug(db.sql);
});
afterAll(async () => {
  await db.close();
});

const BASE_TABLES = [
  "holdings_13f",
  "filings",
  "form4_transactions",
  "filers",
  "securities",
  "companies",
  "insiders",
  "quarterly_prices",
];

describe("anon RLS / grants", () => {
  it("anon cannot SELECT any base table directly, but reaches data via RPC", async () => {
    await db.query("set role anon");
    try {
      // The RPC works for anon (security definer bypasses RLS on its behalf).
      const res = await getFundHoldings(db.sql, {
        fundSlug: brkSlug,
        quarter: BRK_CURRENT_QUARTER,
      });
      expect(res.total_count).toBeGreaterThan(0);

      // Direct base-table reads are denied.
      for (const table of BASE_TABLES) {
        await expect(
          db.query(`select * from ${table} limit 1`),
        ).rejects.toThrow(/permission denied/i);
      }

      // The whitelisted derived views remain readable.
      const viaView = await db.query(
        `select 1 from fund_holdings_enriched limit 1`,
      );
      expect(viaView.length).toBe(1);
    } finally {
      await db.query("reset role");
    }
  });
});
