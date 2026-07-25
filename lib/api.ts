/**
 * Typed read API over the Phase 4 RPC functions.
 *
 * One function per RPC. Each calls its `security definer` SQL function through
 * the `Sql` port (the same port ingestion uses, so these run unchanged against
 * PGlite in tests and a real Postgres in production) and validates the returned
 * jsonb with a zod schema from `./schemasApi` — the schema IS the wire contract
 * (specs/phase-4-api.md). Those schemas are re-exported here, so consumers keep
 * importing everything from `@/lib/api`.
 *
 * The RPCs return a single jsonb value; the Sql port hands it back already
 * parsed (numeric -> number, date -> "YYYY-MM-DD" string). Percentages are on a
 * 0..100 scale (Phase 2 Decision 4) and are passed through untouched.
 *
 * lib/api.ts talks to the DB via the Sql port rather than @supabase/supabase-js
 * (PROGRESS.md Phase 4 decision). A supabase-js adapter can be added in Phase 5
 * when the frontend needs the browser transport; the zod contracts are
 * transport-independent.
 */
import type { Sql } from "./db/sql";
import {
  fundHoldingsSchema,
  fundSummarySchema,
  fundRealtimeSchema,
  stockInstitutionalSchema,
  stockInsidersSchema,
  confluenceSchema,
  type FundHoldings,
  type FundSummary,
  type FundRealtime,
  type StockInstitutional,
  type StockInsiders,
  type Confluence,
} from "./schemasApi";

export * from "./schemasApi";

// --- get_fund_holdings ------------------------------------------------------

export type SortDir = "asc" | "desc";
export interface FundHoldingsParams {
  fundSlug: string;
  quarter: string;
  sortCol?: string;
  sortDir?: SortDir;
  page?: number;
  pageSize?: number;
  search?: string | null;
}

export async function getFundHoldings(
  sql: Sql,
  p: FundHoldingsParams,
): Promise<FundHoldings> {
  const [row] = await sql.query<{ result: unknown }>(
    `select get_fund_holdings($1, $2, $3, $4, $5, $6, $7) as result`,
    [
      p.fundSlug,
      p.quarter,
      p.sortCol ?? "market_value",
      p.sortDir ?? "desc",
      p.page ?? 1,
      p.pageSize ?? 50,
      p.search ?? null,
    ],
  );
  return fundHoldingsSchema.parse(row.result);
}

// --- get_fund_summary -------------------------------------------------------

export async function getFundSummary(
  sql: Sql,
  fundSlug: string,
  quarter?: string | null,
): Promise<FundSummary> {
  const [row] = await sql.query<{ result: unknown }>(
    `select get_fund_summary($1, $2) as result`,
    [fundSlug, quarter ?? null],
  );
  return fundSummarySchema.parse(row.result);
}

// --- get_fund_realtime ------------------------------------------------------

export async function getFundRealtime(
  sql: Sql,
  fundSlug: string,
  limit = 50,
): Promise<FundRealtime> {
  const [row] = await sql.query<{ result: unknown }>(
    `select get_fund_realtime($1, $2) as result`,
    [fundSlug, limit],
  );
  return fundRealtimeSchema.parse(row.result);
}

// --- get_stock_institutional ------------------------------------------------

export async function getStockInstitutional(
  sql: Sql,
  ticker: string,
  quarter: string,
  page = 1,
  pageSize = 50,
): Promise<StockInstitutional> {
  const [row] = await sql.query<{ result: unknown }>(
    `select get_stock_institutional($1, $2, $3, $4) as result`,
    [ticker, quarter, page, pageSize],
  );
  return stockInstitutionalSchema.parse(row.result);
}

// --- get_stock_insiders -----------------------------------------------------

export async function getStockInsiders(
  sql: Sql,
  ticker: string,
  page = 1,
  pageSize = 50,
  codes?: string[] | null,
): Promise<StockInsiders> {
  const [row] = await sql.query<{ result: unknown }>(
    `select get_stock_insiders($1, $2, $3, $4) as result`,
    [ticker, page, pageSize, codes ?? null],
  );
  return stockInsidersSchema.parse(row.result);
}

// --- get_confluence ---------------------------------------------------------

export async function getConfluence(
  sql: Sql,
  ticker: string,
  fromQuarter: string,
): Promise<Confluence> {
  const [row] = await sql.query<{ result: unknown }>(
    `select get_confluence($1, $2) as result`,
    [ticker, fromQuarter],
  );
  return confluenceSchema.parse(row.result);
}
