# Phase 4 — API layer

## Objective
A stable, typed read API over the derived data: RPC functions for heavy
queries, PostgREST for simple reads, one export route.

## Prerequisites
Phases 1–3 complete.

## Deliverables
1. **RPC functions** (migrations, `security definer`, read-only):
   - `get_fund_holdings(fund_slug, quarter, sort_col, sort_dir, page, page_size, search)`
     → enriched holdings rows + total_count. Sorting/pagination server-side;
     whitelist sort_col against known columns (no SQL injection via sort).
   - `get_fund_summary(fund_slug, quarter)` → fund_quarter_summary row +
     available quarters list.
   - `get_fund_realtime(fund_slug, limit)` → Form 4 feed for 10%-owner funds.
   - `get_stock_institutional(ticker, quarter, page, page_size)` → funds
     holding the stock, with position changes.
   - `get_stock_insiders(ticker, page, page_size, codes[])` → Form 4 table
     rows + sentiment summary + active cluster flag.
   - `get_confluence(ticker, from_quarter)` → per-quarter net institutional
     share change + individual insider transactions, shaped for charting.
2. **Typed client** `lib/api.ts`: one function per RPC, zod-parsed responses,
   shared with server components.
3. **Export route** `app/api/export/route.ts?fund=&quarter=&format=csv|tsv`
   → streams the full holdings set with headers matching UI column names.
4. **Security**: RLS enabled on all tables; anon role gets SELECT via the RPC
   functions and specific views only; no direct table reads for anon.
5. **Seed script** `scripts/seed-dev.ts`: loads all fixtures so the app runs
   locally with realistic data (`npm run seed`).

## Acceptance criteria (tests in `tests/phase4/`, run against local Supabase)
- Each RPC returns the documented shape (zod schemas as the contract).
- Pagination: page 2 with page_size 10 returns rows 11–20 of the sorted set.
- Sorting by market_value desc matches SQL ORDER BY ground truth.
- Invalid sort_col rejected with a clean error, not a 500.
- Export CSV row count = holdings count + header; opens as valid CSV
  (parse it back in the test).
- Anon key cannot SELECT directly from `holdings_13f` (RLS proven by test).
- `typecheck`, `lint`, full `test` clean.

## Out of scope
Auth/user accounts, watchlists, alerts, rate limiting (later), UI.
