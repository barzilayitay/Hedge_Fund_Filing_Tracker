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

## AMENDMENT (post-Phase-1 gate review) — holdings_13f row semantics

Phase 1 changed the holdings_13f primary key from the original
(accession_no, cusip, put_call, share_class) to (accession_no, row_index).
Rationale: 13F information tables legitimately contain multiple rows for the
same security within one filing (one row per otherManager combination —
Berkshire reports its Apple position as 12 rows; 60% of fixture rows collapse
under the old PK). Raw rows are preserved exactly as filed and are NEVER
collapsed at ingest.

Consequences that are BINDING for Phase 2:

1. holdings_13f is a row-level table, not a position-level table. There is no
   one-row-per-security guarantee. Any computation of position size, quarter-
   over-quarter change, portfolio weight, top holdings, new/exited positions,
   or filer overlap MUST first aggregate rows within a filing:

       GROUP BY filer, period, cusip, put_call, share_class
       SUM(value_usd), SUM(shares/principal amount)

   Voting authority columns were not captured by the Phase 1 parser/schema
   and are omitted from holdings_13f_agg. The raw XML contains
   <votingAuthority>; capturing it requires a Phase 1 schema + parser change
   and re-ingest, deferred until a phase needs it (candidate: Phase 3+
   governance/ownership views).

   put_call must never be merged with equity rows for the same CUSIP; a put,
   a call, and a share position in the same issuer are three distinct
   positions.

2. Implement this aggregation ONCE as a SQL view named holdings_13f_agg
   (built on top of the amendment-effective filing set, i.e. exclude
   superseded filings). All Phase 2 analytics read from this view. No Phase 2
   query may GROUP BY over raw holdings_13f directly.

3. Aggregation operates on effective filings only: RESTATEMENT amendments
   supersede all prior filings for the period; NEW HOLDINGS amendments union
   with the original (per Phase 1 reconciliation rules).

4. row_index identity is only stable because the Phase 1 loader deletes and
   reloads all rows for an accession atomically on re-ingest. Phase 2 (and all
   later phases) MUST preserve this replace-per-accession behavior; row-level
   upserts against holdings_13f are prohibited.

5. The PK no longer leads on cusip. Phase 2's migration must add a secondary
   index supporting per-security lookups (at minimum: cusip; recommended:
   (cusip, accession_no)) unless it already exists.

Known limitations inherited from Phase 1 (do not rediscover):
- securities seed comes from the SEC Official 13(f) Securities List pinned at
  2026q1; the securities↔companies link is a normalized-name join and is
  lower-confidence than OpenFIGI resolutions. A list-refresh policy is
  deferred (target: Phase 7 ops hardening).
- createOpenFigiClient has never been exercised against the live API; only
  ~34% of fixture CUSIPs resolve from the seed alone. First live invocation
  must be supervised.

## Deferred to later phases (recorded at the Phase 2 gate review)

These are known, accepted gaps at the close of Phase 2; each is tagged with
the phase gate that must resolve it.

a. **Refresh wiring and cadence (→ Phase 6).** `refresh_derived()` is the only
   refresh path, but nothing calls it on ingest — the loader (`load13f`) does
   not, and there is no scheduler. Wiring ingest → `refresh_derived()`, the
   refresh cadence, and switching the function to `REFRESH MATERIALIZED VIEW
   CONCURRENTLY fund_holdings_enriched` (the unique index
   `fund_holdings_enriched_pk` already exists to allow it) are deferred to the
   Phase 6 ops/scheduling work. Until then the matview is stale between loads.

b. **Price provider is unofficial/unkeyed (→ Phase 6/7).** `load-prices.ts`
   uses Yahoo's public chart API (fixtures are frozen, so tests never hit it).
   Yahoo is unofficial, unkeyed, and could rate-limit or break in automated
   ops. Phase 6/7 should choose a keyed provider (e.g. Tiingo / Alpha Vantage)
   for the production refresh path.

c. **`pct_*` columns are on a 0..100 scale (→ Phase 5).** Every percentage
   column (`pct_of_portfolio`, `prior_pct_of_portfolio`, `pct_change`,
   `pct_ownership`, `top10_concentration_pct`, `turnover_pct`, and
   `sector_allocation` values) is already a percent, not a fraction. The Phase 5
   frontend must render them as-is and must NOT multiply by 100 again.

d. **Multi-class issuers have null `pct_ownership` (→ Phase 5).** Issuers such
   as GOOGL do not tag `dei:EntityCommonStockSharesOutstanding`, so their
   `shares_outstanding` is null and `pct_ownership` is legitimately null. A
   future improvement could sum class-level `us-gaap` shares; until then the
   frontend must handle a null `pct_ownership` for a mapped security.
