/**
 * Wire contracts for the Phase 4 read API.
 *
 * Each of the six RPCs returns a single `jsonb` value, and the zod schema here
 * IS that contract (specs/phase-4-api.md) — `lib/api.ts` parses every response
 * through it, so a shape drift in the SQL fails loudly at the boundary instead
 * of propagating a wrong type into the app.
 *
 * Split out of `lib/api.ts` to keep both files inside the ~300-line rule
 * (CLAUDE.md "Style"). `lib/api.ts` re-exports everything here, so consumers
 * import from `@/lib/api` either way. Naming follows lib/edgar/schemas13f.ts
 * and schemasForm4.ts.
 *
 * The Sql port hands jsonb back already parsed (numeric -> number, date ->
 * "YYYY-MM-DD" string). Percentages are on a 0..100 scale (Phase 2 Decision 4)
 * and are passed through untouched.
 */
import { z } from "zod";

// --- shared leaf schemas ----------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const cik = z.string().regex(/^\d{10}$/, "cik must be 10 digits");
const num = z.number();
const putCall = z.enum(["Put", "Call"]).nullable();
const positionStatus = z.enum([
  "NEW",
  "ADDED",
  "REDUCED",
  "UNCHANGED",
  "SOLD_OUT",
]);

const fundRef = z.object({
  cik,
  name: z.string(),
  slug: z.string(),
});

// --- get_fund_holdings ------------------------------------------------------

export const enrichedHoldingSchema = z.object({
  cik,
  period_of_report: isoDate,
  cusip: z.string(),
  ticker: z.string().nullable(),
  name: z.string().nullable(),
  put_call: putCall,
  share_class: z.string().nullable(),
  sector: z.string().nullable(),
  shares: num.nullable(),
  principal_amt: num.nullable(),
  market_value: num,
  prior_market_value: num,
  pct_of_portfolio: num.nullable(),
  prior_pct_of_portfolio: num.nullable(),
  rank: num.nullable(),
  change_in_shares: num.nullable(),
  pct_change: num.nullable(),
  position_status: positionStatus,
  pct_ownership: num.nullable(),
  qtr_first_owned: isoDate.nullable(),
  est_avg_price: num.nullable(),
  quarter_end_price: num.nullable(),
});
export type EnrichedHolding = z.infer<typeof enrichedHoldingSchema>;

export const fundHoldingsSchema = z.object({
  fund: fundRef.nullable(),
  quarter: isoDate.nullable(),
  total_count: z.number().int().nonnegative(),
  rows: z.array(enrichedHoldingSchema),
});
export type FundHoldings = z.infer<typeof fundHoldingsSchema>;

// --- get_fund_summary -------------------------------------------------------

// The fixed jsonb_build_object shapes emitted by fund_quarter_summary
// (analytics.sql). ticker/share_class/shares are nullable at the source; cusip,
// market_value and value_dropped are not.
export const topNewBuySchema = z.object({
  ticker: z.string().nullable(),
  cusip: z.string(),
  share_class: z.string().nullable(),
  market_value: num,
  shares: num.nullable(),
});
export type TopNewBuy = z.infer<typeof topNewBuySchema>;

export const topSellSchema = z.object({
  ticker: z.string().nullable(),
  cusip: z.string(),
  share_class: z.string().nullable(),
  position_status: z.enum(["REDUCED", "SOLD_OUT"]),
  value_dropped: num,
});
export type TopSell = z.infer<typeof topSellSchema>;

export const fundSummaryRowSchema = z.object({
  cik,
  period_of_report: isoDate,
  portfolio_value: num,
  num_holdings: z.number().int(),
  top10_concentration_pct: num.nullable(),
  turnover_pct: num.nullable(),
  sector_allocation: z.record(z.string(), num),
  top_new_buys: z.array(topNewBuySchema),
  top_sells: z.array(topSellSchema),
});
export type FundSummaryRow = z.infer<typeof fundSummaryRowSchema>;

export const fundSummarySchema = z.object({
  fund: fundRef.nullable(),
  quarter: isoDate.nullable(),
  summary: fundSummaryRowSchema.nullable(),
  quarters: z.array(isoDate),
});
export type FundSummary = z.infer<typeof fundSummarySchema>;

// --- get_fund_realtime ------------------------------------------------------

export const realtimeRowSchema = z.object({
  fund_cik: cik,
  fund_name: z.string(),
  fund_slug: z.string(),
  accession_no: z.string(),
  company_cik: cik,
  table_type: z.enum(["nonderiv", "deriv"]),
  row_index: z.number().int(),
  security_title: z.string().nullable(),
  transaction_code: z.string().nullable(),
  transaction_date: isoDate.nullable(),
  shares: num.nullable(),
  price: num.nullable(),
  acquired_disposed: z.enum(["A", "D"]).nullable(),
  shares_owned_after: num.nullable(),
  is_10b5_1: z.boolean(),
});
export type RealtimeRow = z.infer<typeof realtimeRowSchema>;

export const fundRealtimeSchema = z.object({
  fund: fundRef.nullable(),
  rows: z.array(realtimeRowSchema),
});
export type FundRealtime = z.infer<typeof fundRealtimeSchema>;

// --- get_stock_institutional ------------------------------------------------

export const stockInstitutionalRowSchema = z.object({
  fund_cik: cik,
  fund_name: z.string(),
  fund_slug: z.string(),
  put_call: putCall,
  share_class: z.string().nullable(),
  shares: num.nullable(),
  market_value: num,
  pct_of_portfolio: num.nullable(),
  change_in_shares: num.nullable(),
  pct_change: num.nullable(),
  position_status: positionStatus,
  rank: num.nullable(),
  pct_ownership: num.nullable(),
});
export type StockInstitutionalRow = z.infer<typeof stockInstitutionalRowSchema>;

export const stockInstitutionalSchema = z.object({
  ticker: z.string(),
  quarter: isoDate.nullable(),
  total_count: z.number().int().nonnegative(),
  rows: z.array(stockInstitutionalRowSchema),
});
export type StockInstitutional = z.infer<typeof stockInstitutionalSchema>;

// --- get_stock_insiders -----------------------------------------------------

export const insiderTxnRowSchema = z.object({
  accession_no: z.string(),
  insider_cik: cik,
  insider_name: z.string(),
  company_cik: cik,
  table_type: z.enum(["nonderiv", "deriv"]),
  row_index: z.number().int(),
  security_title: z.string().nullable(),
  transaction_code: z.string().nullable(),
  transaction_date: isoDate.nullable(),
  shares: num.nullable(),
  price: num.nullable(),
  acquired_disposed: z.enum(["A", "D"]).nullable(),
  shares_owned_after: num.nullable(),
  direct_indirect: z.enum(["D", "I"]).nullable(),
  nature_of_ownership: z.string().nullable(),
  is_10b5_1: z.boolean(),
  conversion_or_exercise_price: num.nullable(),
  exercise_date: isoDate.nullable(),
  expiration_date: isoDate.nullable(),
  underlying_security_title: z.string().nullable(),
  underlying_shares: num.nullable(),
  footnotes: z.record(z.string(), z.unknown()),
});
export type InsiderTxnRow = z.infer<typeof insiderTxnRowSchema>;

export const sentimentSchema = z.object({
  company_cik: cik,
  as_of: isoDate,
  buy_count: z.number().int(),
  sell_count: z.number().int(),
  planned_sell_count: z.number().int(),
  net_value: num,
  planned_sell_value: num,
});
export type Sentiment = z.infer<typeof sentimentSchema>;

export const stockInsidersSchema = z.object({
  ticker: z.string(),
  company_cik: cik.nullable(),
  total_count: z.number().int().nonnegative(),
  rows: z.array(insiderTxnRowSchema),
  sentiment: sentimentSchema.nullable(),
  has_active_cluster: z.boolean(),
});
export type StockInsiders = z.infer<typeof stockInsidersSchema>;

// --- get_confluence ---------------------------------------------------------

export const confluenceInstitutionalSchema = z.object({
  quarter: isoDate,
  net_share_change: num.nullable(),
  num_funds: z.number().int(),
  total_market_value: num.nullable(),
});

export const confluenceInsiderSchema = z.object({
  transaction_date: isoDate,
  insider_cik: cik,
  insider_name: z.string(),
  transaction_code: z.string(),
  shares: num.nullable(),
  price: num.nullable(),
  acquired_disposed: z.enum(["A", "D"]).nullable(),
  is_10b5_1: z.boolean(),
  value: num,
  accession_no: z.string(),
  row_index: z.number().int(),
});

export const confluenceSchema = z.object({
  ticker: z.string(),
  from_quarter: isoDate,
  institutional: z.array(confluenceInstitutionalSchema),
  insiders: z.array(confluenceInsiderSchema),
});
export type Confluence = z.infer<typeof confluenceSchema>;
