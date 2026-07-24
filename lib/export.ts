/**
 * Holdings export (CSV / TSV).
 *
 * The route handler (app/api/export/route.ts) is a thin wrapper over
 * buildHoldingsExport, which pages the full holdings set through the same
 * get_fund_holdings RPC the rest of the API uses and serialises it with headers
 * matching the UI column names. Kept here (not in the route) so it is unit-
 * testable against PGlite without a running server.
 */
import type { Sql } from "./db/sql";
import { getFundHoldings, type EnrichedHolding } from "./api";

export type ExportFormat = "csv" | "tsv";

/** Ordered export columns: [UI header, value accessor]. */
const COLUMNS: ReadonlyArray<
  readonly [string, (h: EnrichedHolding) => unknown]
> = [
  ["Ticker", (h) => h.ticker],
  ["Name", (h) => h.name],
  ["CUSIP", (h) => h.cusip],
  ["Sector", (h) => h.sector],
  ["Put/Call", (h) => h.put_call],
  ["Share Class", (h) => h.share_class],
  ["Shares", (h) => h.shares],
  ["Principal Amount", (h) => h.principal_amt],
  ["Market Value", (h) => h.market_value],
  ["% of Portfolio", (h) => h.pct_of_portfolio],
  ["Prior % of Portfolio", (h) => h.prior_pct_of_portfolio],
  ["Rank", (h) => h.rank],
  ["Change in Shares", (h) => h.change_in_shares],
  ["% Change", (h) => h.pct_change],
  ["Position Status", (h) => h.position_status],
  ["% Ownership", (h) => h.pct_ownership],
  ["Qtr First Owned", (h) => h.qtr_first_owned],
  ["Est. Avg Price", (h) => h.est_avg_price],
  ["Quarter-End Price", (h) => h.quarter_end_price],
];

export const EXPORT_HEADERS: readonly string[] = COLUMNS.map(([h]) => h);

/**
 * CSV/TSV injection defense. A cell beginning with a formula-trigger character
 * is executed as a formula by Excel/Sheets when the file is opened. Values like
 * the issuer Name come from filer-controlled 13F XML, so neutralize any cell
 * that starts with one by prefixing a single quote (the standard, reversible
 * mitigation — the leading `'` makes the app treat the cell as text).
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** One field, neutralized for spreadsheet formula injection then RFC-4180 quoted. */
function escapeField(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (FORMULA_PREFIX.test(s)) {
    s = `'${s}`;
  }
  if (s.includes(delimiter) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialise enriched holdings to a CSV/TSV string (header row + one per row). */
export function holdingsToDelimited(
  rows: EnrichedHolding[],
  format: ExportFormat,
): string {
  const delimiter = format === "tsv" ? "\t" : ",";
  const lines: string[] = [];
  lines.push(COLUMNS.map(([h]) => escapeField(h, delimiter)).join(delimiter));
  for (const row of rows) {
    lines.push(
      COLUMNS.map(([, get]) => escapeField(get(row), delimiter)).join(delimiter),
    );
  }
  // CRLF line endings, the CSV convention most spreadsheet tools expect.
  return lines.join("\r\n") + "\r\n";
}

export interface HoldingsExportParams {
  fundSlug: string;
  quarter: string;
  format?: ExportFormat;
}

export interface HoldingsExport {
  filename: string;
  contentType: string;
  content: string;
  rowCount: number;
}

const PAGE_SIZE = 500;

/** Fetch every holding for a fund-quarter (paging the RPC) and serialise it. */
export async function buildHoldingsExport(
  sql: Sql,
  params: HoldingsExportParams,
): Promise<HoldingsExport> {
  const format: ExportFormat = params.format === "tsv" ? "tsv" : "csv";
  const all: EnrichedHolding[] = [];
  let page = 1;
  let total = Infinity;
  while (all.length < total) {
    const res = await getFundHoldings(sql, {
      fundSlug: params.fundSlug,
      quarter: params.quarter,
      sortCol: "market_value",
      sortDir: "desc",
      page,
      pageSize: PAGE_SIZE,
    });
    total = res.total_count;
    all.push(...res.rows);
    if (res.rows.length === 0) break;
    page += 1;
  }

  const content = holdingsToDelimited(all, format);
  const contentType =
    format === "tsv" ? "text/tab-separated-values" : "text/csv";
  return {
    filename: `${params.fundSlug}-${params.quarter}.${format}`,
    contentType,
    content,
    rowCount: all.length,
  };
}
