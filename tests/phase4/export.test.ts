import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedPhase4, berkshireSlug, BRK_CURRENT_QUARTER } from "../helpers/phase4";
import { getFundHoldings } from "@/lib/api";
import { buildHoldingsExport, EXPORT_HEADERS } from "@/lib/export";

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
