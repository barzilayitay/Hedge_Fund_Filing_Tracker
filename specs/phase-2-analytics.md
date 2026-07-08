# Phase 2 — Derived analytics

## Objective
Compute every column of the WhaleWisdom-style holdings table and the fund
summary, as SQL views over Phase 1 tables.

## Prerequisites
Phase 1 complete (Berkshire two-quarter fixtures loaded by test setup).

## Deliverables
1. **Migration**: `quarterly_prices` table + a seed of fixture prices
   (`fixtures/prices/quarterly_prices.csv` — commit ~30 tickers × 3 quarters,
   sourced once from a free provider, then frozen).
2. **Script** `scripts/load-prices.ts` for production use (Stooq or equivalent
   free quarter-end closes); not exercised by tests.
3. **Shares outstanding**: `scripts/load-companyfacts.ts` populating
   `companies.shares_outstanding` from committed companyfacts fixtures for the
   spot-check tickers.
4. **Materialized view `fund_holdings_enriched`** with columns:
   ticker, name, put_call, share_class, sector, shares, principal_amt,
   market_value, pct_of_portfolio, prior_pct_of_portfolio, rank,
   change_in_shares, pct_change, position_status
   (NEW / ADDED / REDUCED / UNCHANGED / SOLD_OUT — SOLD_OUT rows synthesized
   from prior quarter), pct_ownership (shares / shares_outstanding),
   qtr_first_owned, est_avg_price, quarter_end_price.
5. **View `fund_quarter_summary`**: portfolio_value, num_holdings,
   top10_concentration_pct, turnover_pct
   (0.5 × Σ|Δvalue| / avg portfolio value — document the formula in a comment),
   sector_allocation jsonb, top_new_buys jsonb (5), top_sells jsonb (5).
6. **`est_avg_price`** heuristic: share-change-weighted average of quarterly
   mean prices across the position's history; when history is incomplete,
   fall back to current-quarter mean; always emit, never null for priced tickers.
7. `REFRESH` helper function `refresh_derived()` (RPC) called after ingest.
8. Expected-values file `fixtures/13f/berkshire.diff.expected.json` —
   hand-computed for 8 positions covering every position_status, plus the
   summary numbers.

## Implementation notes / pitfalls
- Diffs join on (cusip, put_call, share_class), not ticker — ticker can be
  null for unmapped CUSIPs and those rows must still diff correctly.
- prior_pct and rank come from the prior *effective* filing
  (`filings_effective`), so amendment handling flows through automatically.
- pct_ownership only for SH rows with a mapped company; else null.
- Guard divide-by-zero everywhere (empty prior quarter = everything NEW).

## Acceptance criteria (tests in `tests/phase2/`)
- All 8 hand-computed positions match to 4 decimal places on every column.
- Summary numbers (value, count, top-10 %, turnover, top buys/sells) match
  expected file.
- A quarter with no prior filing yields all-NEW statuses and null prior_pct
  without errors.
- Unmapped-CUSIP holding appears in enriched view with null ticker/sector and
  correct pct_of_portfolio.
- `refresh_derived()` runs in under 10s on fixture data.
- `typecheck`, `lint`, full `test` clean.

## Out of scope
Live price feeds, backfills, API surface, UI.
