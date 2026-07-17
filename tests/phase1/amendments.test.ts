import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { load13f } from "@/lib/edgar/load13f";
import { parse13f } from "@/lib/edgar/parse13f";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  manifestEntry,
  parseFixture,
  readCoverXml,
  readExpected,
  readInfoTableXml,
} from "../helpers/fixtures";

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

/** Total value of a filer's holdings for a period, read through the view. */
async function effectiveTotal(cik: string, period: string): Promise<number> {
  const [row] = await db.query<{ total: string | null }>(
    `select coalesce(sum(h.value_usd), 0)::text as total
       from holdings_13f h
       join filings_effective f on f.accession_no = h.accession_no
      where f.cik = $1 and f.period_of_report = $2`,
    [cik, period],
  );
  return Number(row.total);
}

async function effectiveAccessions(
  cik: string,
  period: string,
): Promise<string[]> {
  const rows = await db.query<{ accession_no: string }>(
    `select accession_no from filings_effective
      where cik = $1 and period_of_report = $2
      order by accession_no`,
    [cik, period],
  );
  return rows.map((r) => r.accession_no);
}

async function effectiveRowCount(cik: string, period: string): Promise<number> {
  const [row] = await db.query<{ n: string }>(
    `select count(*)::text as n
       from holdings_13f h
       join filings_effective f on f.accession_no = h.accession_no
      where f.cik = $1 and f.period_of_report = $2`,
    [cik, period],
  );
  return Number(row.n);
}

describe("RESTATEMENT", () => {
  const ORIGINAL = "gfi-restatement-original-2025-02-12";
  const AMENDMENT = "gfi-restatement-amendment-2025-06-10";
  const CIK = "0001688774";
  const PERIOD = "2024-12-31";

  it("supersedes the original; only the /A stays effective", async () => {
    await load13f(db.sql, parseFixture(ORIGINAL));
    await load13f(db.sql, parseFixture(AMENDMENT));

    const amendment = readExpected(AMENDMENT);
    expect(await effectiveAccessions(CIK, PERIOD)).toEqual([
      amendment.accession,
    ]);

    const [original] = await db.query<{ is_superseded: boolean }>(
      `select is_superseded from filings where accession_no = $1`,
      [readExpected(ORIGINAL).accession],
    );
    expect(original.is_superseded).toBe(true);
  });

  it("totals the /A only — the original is not double counted", async () => {
    await load13f(db.sql, parseFixture(ORIGINAL));
    await load13f(db.sql, parseFixture(AMENDMENT));

    const originalTotal = readExpected(ORIGINAL).totalValueUsd;
    const amendmentTotal = readExpected(AMENDMENT).totalValueUsd;

    // This /A restates $ thousands to whole dollars, so a wrong answer here
    // is off by ~1000x rather than by a rounding error.
    expect(await effectiveTotal(CIK, PERIOD)).toBe(amendmentTotal);
    expect(await effectiveTotal(CIK, PERIOD)).not.toBe(
      originalTotal + amendmentTotal,
    );
    expect(await effectiveRowCount(CIK, PERIOD)).toBe(
      readExpected(AMENDMENT).rowCount,
    );
  });

  it("links the /A to the filing it amends", async () => {
    await load13f(db.sql, parseFixture(ORIGINAL));
    await load13f(db.sql, parseFixture(AMENDMENT));

    const [row] = await db.query<{ amends_accession_no: string | null }>(
      `select amends_accession_no from filings where accession_no = $1`,
      [readExpected(AMENDMENT).accession],
    );
    expect(row.amends_accession_no).toBe(readExpected(ORIGINAL).accession);
  });

  it("reaches the same state when the /A is ingested first", async () => {
    // The poller has no ordering guarantee, so reconciliation must not depend
    // on arrival order.
    await load13f(db.sql, parseFixture(AMENDMENT));
    expect(await effectiveAccessions(CIK, PERIOD)).toEqual([
      readExpected(AMENDMENT).accession,
    ]);

    await load13f(db.sql, parseFixture(ORIGINAL));

    expect(await effectiveAccessions(CIK, PERIOD)).toEqual([
      readExpected(AMENDMENT).accession,
    ]);
    expect(await effectiveTotal(CIK, PERIOD)).toBe(
      readExpected(AMENDMENT).totalValueUsd,
    );
  });
});

describe("NEW HOLDINGS", () => {
  const ORIGINAL = "brk-newholdings-original-2024-02-14";
  const AMENDMENT = "brk-newholdings-amendment-2024-05-15";
  const CIK = "0001067983";
  const PERIOD = "2023-12-31";

  it("keeps both filings effective", async () => {
    await load13f(db.sql, parseFixture(ORIGINAL));
    await load13f(db.sql, parseFixture(AMENDMENT));

    expect(readExpected(AMENDMENT).amendmentType).toBe("NEW HOLDINGS");
    expect((await effectiveAccessions(CIK, PERIOD)).sort()).toEqual(
      [readExpected(ORIGINAL).accession, readExpected(AMENDMENT).accession].sort(),
    );
  });

  it("unions the /A rows onto the original's", async () => {
    await load13f(db.sql, parseFixture(ORIGINAL));
    await load13f(db.sql, parseFixture(AMENDMENT));

    const original = readExpected(ORIGINAL);
    const amendment = readExpected(AMENDMENT);

    expect(await effectiveRowCount(CIK, PERIOD)).toBe(
      original.rowCount + amendment.rowCount,
    );
    expect(await effectiveTotal(CIK, PERIOD)).toBe(
      original.totalValueUsd + amendment.totalValueUsd,
    );
  });

  it("appends the previously confidential holding", async () => {
    await load13f(db.sql, parseFixture(ORIGINAL));
    await load13f(db.sql, parseFixture(AMENDMENT));

    // The /A discloses Chubb, which is absent from the original.
    const rows = await db.query<{ accession_no: string }>(
      `select h.accession_no
         from holdings_13f h
         join filings_effective f on f.accession_no = h.accession_no
        where f.cik = $1 and f.period_of_report = $2 and h.cusip = 'H1467J104'`,
      [CIK, PERIOD],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].accession_no).toBe(readExpected(AMENDMENT).accession);
  });

  it("handles a second NEW HOLDINGS pair the same way", async () => {
    const original = "brk-newholdings-q1-2025-original-2025-05-15";
    const amendment = "brk-newholdings-q1-2025-amendment-2025-08-14";
    await load13f(db.sql, parseFixture(original));
    await load13f(db.sql, parseFixture(amendment));

    expect(await effectiveRowCount(CIK, "2025-03-31")).toBe(
      readExpected(original).rowCount + readExpected(amendment).rowCount,
    );
  });
});

describe("amendmentType detection", () => {
  it("defaults a 13F-HR/A with no amendmentType to RESTATEMENT and warns", () => {
    // Conservative: assuming RESTATEMENT can never double count.
    const label = "brk-newholdings-amendment-2024-05-15";
    const cover = readCoverXml(label).replace(
      /<amendmentType>[^<]*<\/amendmentType>/,
      "",
    );
    const entry = manifestEntry(label);

    const parsed = parse13f(cover, readInfoTableXml(label), {
      accessionNo: entry.accession,
      filedAt: entry.filedAt,
    });

    expect(parsed.filing.amendmentType).toBe("RESTATEMENT");
    expect(parsed.warnings).toContainEqual(
      expect.stringContaining("defaulting to RESTATEMENT"),
    );
  });

  it("defaults an unrecognized amendmentType to RESTATEMENT and warns", () => {
    const label = "brk-newholdings-amendment-2024-05-15";
    const cover = readCoverXml(label).replace(
      /<amendmentType>[^<]*<\/amendmentType>/,
      "<amendmentType>SOMETHING ELSE</amendmentType>",
    );
    const entry = manifestEntry(label);

    const parsed = parse13f(cover, readInfoTableXml(label), {
      accessionNo: entry.accession,
      filedAt: entry.filedAt,
    });

    expect(parsed.filing.amendmentType).toBe("RESTATEMENT");
    expect(parsed.warnings).toContainEqual(
      expect.stringContaining("SOMETHING ELSE"),
    );
  });

  it("leaves amendmentType null on an original filing", () => {
    const parsed = parseFixture("brk-2026-05-15");
    expect(parsed.filing.isAmendment).toBe(false);
    expect(parsed.filing.amendmentType).toBeNull();
    expect(parsed.warnings).toEqual([]);
  });

  it("reads NEW HOLDINGS rather than assuming from the filing name", () => {
    // Phase 0 named this pair "restatement-*"; the filing says otherwise.
    expect(
      parseFixture("brk-newholdings-q1-2025-amendment-2025-08-14").filing
        .amendmentType,
    ).toBe("NEW HOLDINGS");
  });
});

describe("filings_effective view", () => {
  it("excludes superseded filings and nothing else", async () => {
    await load13f(db.sql, parseFixture("gfi-restatement-original-2025-02-12"));
    await load13f(db.sql, parseFixture("gfi-restatement-amendment-2025-06-10"));
    await load13f(db.sql, parseFixture("brk-2026-05-15"));

    const [all] = await db.query<{ n: string }>(
      `select count(*)::text as n from filings`,
    );
    const [effective] = await db.query<{ n: string }>(
      `select count(*)::text as n from filings_effective`,
    );
    const [superseded] = await db.query<{ n: string }>(
      `select count(*)::text as n from filings where is_superseded`,
    );

    expect(Number(all.n)).toBe(3);
    expect(Number(superseded.n)).toBe(1);
    expect(Number(effective.n)).toBe(2);
  });
});
