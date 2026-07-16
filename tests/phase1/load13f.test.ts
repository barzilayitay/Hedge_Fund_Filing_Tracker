import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { load13f } from "@/lib/edgar/load13f";
import { createTestDb, type TestDb } from "../helpers/db";
import { parseFixture, readExpected, readManifest } from "../helpers/fixtures";

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

const BERKSHIRE = "brk-2026-05-15";

/**
 * Every column of every table except the timestamps, which the spec allows to
 * move ("updated_at aside").
 */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const tables = ["filers", "filings", "securities", "holdings_13f"];
  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    // Order by the serialized row so the comparison does not depend on the
    // physical order Postgres happens to return.
    out[table] = await db.query(
      `select to_jsonb(t) - 'created_at' - 'updated_at' as row
         from ${table} t
        order by (to_jsonb(t) - 'created_at' - 'updated_at')::text`,
    );
  }
  return out;
}

describe("load13f", () => {
  it("loads a filing's rows, filer and filing metadata", async () => {
    const parsed = parseFixture(BERKSHIRE);
    const expected = readExpected(BERKSHIRE);

    const result = await load13f(db.sql, parsed);
    expect(result.holdingsLoaded).toBe(expected.rowCount);

    const [filer] = await db.query<{ cik: string; name: string; slug: string }>(
      `select cik, name, slug from filers`,
    );
    expect(filer).toMatchObject({
      cik: expected.cik,
      name: expected.filerName,
      slug: expected.filerSlug,
    });

    const [filing] = await db.query<{
      accession_no: string;
      form_type: string;
      period_of_report: string;
      is_superseded: boolean;
      amendment_type: string | null;
    }>(
      `select accession_no, form_type, period_of_report::text as period_of_report,
              is_superseded, amendment_type
         from filings`,
    );
    expect(filing).toMatchObject({
      accession_no: expected.accession,
      form_type: expected.formType,
      period_of_report: expected.periodOfReport,
      is_superseded: false,
      amendment_type: null,
    });

    const [holdings] = await db.query<{ n: string; total: string }>(
      `select count(*)::text as n, sum(value_usd)::text as total
         from holdings_13f where accession_no = $1`,
      [expected.accession],
    );
    expect(Number(holdings.n)).toBe(expected.rowCount);
    expect(Number(holdings.total)).toBe(expected.totalValueUsd);
  });

  it("is idempotent: loading the same filing twice changes nothing", async () => {
    const parsed = parseFixture(BERKSHIRE);

    await load13f(db.sql, parsed);
    const first = await snapshot();

    await load13f(db.sql, parsed);
    const second = await snapshot();

    expect(second).toEqual(first);
    expect(second.holdings_13f).toHaveLength(readExpected(BERKSHIRE).rowCount);
  });

  it("keeps every information-table row, including repeated CUSIPs", async () => {
    // The spec's PK (accession, cusip, put_call, share_class) would collapse
    // Berkshire's 90 rows to 29, because it reports a security once per
    // otherManager combination.
    const expected = readExpected(BERKSHIRE);
    await load13f(db.sql, parseFixture(BERKSHIRE));

    const [counts] = await db.query<{ rows: string; cusips: string }>(
      `select count(*)::text as rows, count(distinct cusip)::text as cusips
         from holdings_13f`,
    );
    expect(Number(counts.rows)).toBe(expected.rowCount);
    expect(Number(counts.cusips)).toBe(expected.distinctCusips);
    expect(Number(counts.rows)).toBeGreaterThan(Number(counts.cusips));

    const apple = await db.query<{ shares: string; other_manager: string }>(
      `select shares::text, other_manager from holdings_13f where cusip = '037833100'`,
    );
    expect(apple).toHaveLength(12);
    expect(apple.reduce((s, r) => s + Number(r.shares), 0)).toBe(227_917_808);
  });

  it("re-loading after a row is tampered with restores the filing", async () => {
    const parsed = parseFixture(BERKSHIRE);
    await load13f(db.sql, parsed);
    const original = await snapshot();

    await db.query(
      `update holdings_13f set value_usd = 1, shares = 1 where row_index = 0`,
    );
    await db.query(`delete from holdings_13f where row_index = 5`);

    await load13f(db.sql, parsed);
    expect(await snapshot()).toEqual(original);
  });

  it("removes rows left over when a filing re-parses to fewer rows", async () => {
    const parsed = parseFixture(BERKSHIRE);
    await load13f(db.sql, parsed);

    const shorter = { ...parsed, holdings: parsed.holdings.slice(0, 10) };
    await load13f(db.sql, shorter);

    const [row] = await db.query<{ n: string }>(
      `select count(*)::text as n from holdings_13f`,
    );
    expect(Number(row.n)).toBe(10);
  });

  it("creates a securities row for every CUSIP so holdings never block", async () => {
    await load13f(db.sql, parseFixture(BERKSHIRE));

    const [row] = await db.query<{ n: string }>(
      `select count(*)::text as n
         from holdings_13f h
         left join securities s on s.cusip = h.cusip
        where s.cusip is null`,
    );
    expect(Number(row.n)).toBe(0);
  });

  it("stores PRN rows as principal_amt and SH rows as shares", async () => {
    for (const m of readManifest()) {
      await db.reset();
      await load13f(db.sql, parseFixture(m.label));
      const [row] = await db.query<{ n: string }>(
        `select count(*)::text as n from holdings_13f
          where (shares is null) = (principal_amt is null)`,
      );
      expect(Number(row.n), m.label).toBe(0);
    }
  });

  it("loads every fixture and matches its expected totals", async () => {
    for (const m of readManifest()) {
      await db.reset();
      const expected = readExpected(m.label);
      await load13f(db.sql, parseFixture(m.label));

      const [row] = await db.query<{ n: string; total: string }>(
        `select count(*)::text as n, coalesce(sum(value_usd), 0)::text as total
           from holdings_13f`,
      );
      expect(Number(row.n), m.label).toBe(expected.rowCount);
      expect(Number(row.total), m.label).toBe(expected.totalValueUsd);
    }
  });
});
