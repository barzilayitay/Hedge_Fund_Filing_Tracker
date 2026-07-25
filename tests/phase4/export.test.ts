import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedPhase4, berkshireSlug, BRK_CURRENT_QUARTER } from "../helpers/phase4";
import { getFundHoldings, type EnrichedHolding } from "@/lib/api";
import {
  buildHoldingsExport,
  holdingsToDelimited,
  EXPORT_HEADERS,
} from "@/lib/export";

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

/** Minimal RFC-4180 parser (quotes, escaped quotes, CRLF), enough to re-read our output. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // swallow; the \n handles the row break
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe("buildHoldingsExport", () => {
  it("CSV: row count = holdings + header, and re-parses as valid CSV", async () => {
    const holdings = await getFundHoldings(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
      pageSize: 500,
    });
    const total = holdings.total_count;
    expect(total).toBeGreaterThan(0);

    const out = await buildHoldingsExport(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
      format: "csv",
    });
    expect(out.rowCount).toBe(total);
    expect(out.filename).toBe(`${brkSlug}-${BRK_CURRENT_QUARTER}.csv`);
    expect(out.contentType).toBe("text/csv");

    const parsed = parseDelimited(out.content, ",");
    // header + one row per holding.
    expect(parsed).toHaveLength(total + 1);
    expect(parsed[0]).toEqual([...EXPORT_HEADERS]);
    // every data row has the full column count.
    for (const r of parsed.slice(1)) {
      expect(r).toHaveLength(EXPORT_HEADERS.length);
    }
  });

  it("TSV: uses tab delimiter and the same header/row contract", async () => {
    const holdings = await getFundHoldings(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
      pageSize: 500,
    });
    const out = await buildHoldingsExport(db.sql, {
      fundSlug: brkSlug,
      quarter: BRK_CURRENT_QUARTER,
      format: "tsv",
    });
    expect(out.contentType).toBe("text/tab-separated-values");
    const parsed = parseDelimited(out.content, "\t");
    expect(parsed).toHaveLength(holdings.total_count + 1);
    expect(parsed[0]).toEqual([...EXPORT_HEADERS]);
  });

  it("unknown fund exports just the header row", async () => {
    const out = await buildHoldingsExport(db.sql, {
      fundSlug: "no-such-fund",
      quarter: BRK_CURRENT_QUARTER,
      format: "csv",
    });
    expect(out.rowCount).toBe(0);
    const parsed = parseDelimited(out.content, ",");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual([...EXPORT_HEADERS]);
  });
});

describe("holdingsToDelimited CSV/formula-injection safety", () => {
  // A holding whose issuer Name and Sector — both filer-controlled 13F free
  // text — begin with spreadsheet formula triggers.
  function maliciousRow(overrides: Partial<EnrichedHolding>): EnrichedHolding {
    return {
      cik: "0001067983",
      period_of_report: "2026-03-31",
      cusip: "037833100",
      ticker: "AAPL",
      name: "=cmd|' /C calc'!A0",
      put_call: null,
      share_class: null,
      sector: "+SUM(1)",
      shares: 100,
      principal_amt: null,
      market_value: 5000,
      prior_market_value: 0,
      pct_of_portfolio: 1,
      prior_pct_of_portfolio: null,
      rank: 1,
      change_in_shares: 100,
      pct_change: null,
      position_status: "NEW",
      pct_ownership: null,
      qtr_first_owned: "2026-03-31",
      est_avg_price: null,
      quarter_end_price: null,
      ...overrides,
    };
  }

  it("neutralizes formula-prefixed cells by prepending a single quote", () => {
    const csv = holdingsToDelimited([maliciousRow({})], "csv");
    const dataLine = csv.split("\r\n")[1];
    // Name is column index 1 (after Ticker). It must be quoted (contains a comma
    // and quotes) and start with the neutralizing single quote, not a bare '='.
    const nameIdx = EXPORT_HEADERS.indexOf("Name");
    const sectorIdx = EXPORT_HEADERS.indexOf("Sector");
    const parsed = parseDelimited(csv, ",");
    expect(parsed[1][nameIdx]).toBe("'=cmd|' /C calc'!A0");
    expect(parsed[1][sectorIdx]).toBe("'+SUM(1)");
    // No un-neutralized formula trigger begins any raw field on the data line.
    for (const cell of dataLine.split(",")) {
      const unquoted = cell.replace(/^"|"$/g, "");
      expect(/^[=+\-@]/.test(unquoted)).toBe(false);
    }
  });

  it("covers -, @, tab and CR leading characters", () => {
    for (const bad of ["-2+3", "@X", "\tX", "\rX"]) {
      const csv = holdingsToDelimited([maliciousRow({ name: bad })], "csv");
      const nameIdx = EXPORT_HEADERS.indexOf("Name");
      const parsed = parseDelimited(csv, ",");
      expect(parsed[1][nameIdx].startsWith("'")).toBe(true);
    }
  });

  it("leaves ordinary values untouched", () => {
    const csv = holdingsToDelimited(
      [maliciousRow({ name: "Apple Inc", sector: "Technology" })],
      "csv",
    );
    const parsed = parseDelimited(csv, ",");
    expect(parsed[1][EXPORT_HEADERS.indexOf("Name")]).toBe("Apple Inc");
    expect(parsed[1][EXPORT_HEADERS.indexOf("Sector")]).toBe("Technology");
  });
});
