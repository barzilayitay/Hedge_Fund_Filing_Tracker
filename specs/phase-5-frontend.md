# Phase 5 — Frontend

## Objective
The user-facing app: fund pages, stock pages, insider feed, confluence view.
This phase gets an extra human visual review — build to the e2e specs first,
polish second.

## Prerequisites
Phase 4 complete; `npm run seed` gives a working local dataset.

## Pages & routes
1. **`/fund/[slug]`** — tabs:
   - **Summary**: portfolio value, holdings count, top-10 concentration,
     turnover; sector allocation chart (Recharts pie/bar); top new buys and
     top sells cards.
   - **Holdings**: quarter selector; TanStack Table with columns
     (ticker+name, put/call badge, sector, shares/principal, market value,
     % of portfolio, prior %, rank, Δ shares, % change, status badge,
     % ownership, qtr first owned, est avg price, qtr-end price);
     server-side sort + pagination via `get_fund_holdings`; text filter;
     column show/hide menu; Export CSV/TSV buttons hitting the export route.
   - **Buys & sells**: holdings filtered to NEW/ADDED and REDUCED/SOLD_OUT,
     two stacked tables.
   - **Real-time activity**: `get_fund_realtime` feed (only rendered when the
     fund has Form 4 rows; otherwise an explainer of why most funds don't).
   - **Insider signals**: stocks in current holdings with active cluster buys
     or strongly one-sided 90-day sentiment.
2. **`/stock/[ticker]`** — tabs: Institutional owners | Insiders | Confluence.
   - Insiders table: insider, title/relationship, code badge (P green, S red,
     M/A/G neutral), 10b5-1 tag on flagged sales, date, shares, price, value,
     owned after, D/I. Cluster-buy banner when active.
   - Confluence: Recharts composed chart — quarterly net institutional share
     change as bars, insider buys/sells as scatter markers, price line if
     price data exists.
3. **`/insiders`** — global recent Form 4 feed, filter by code and min value,
   cluster-buy highlights.
4. **`/`** — search (funds by name, stocks by ticker), latest-filings list.

## Design constraints
- Data-dense, fast, no decoration: think terminal-adjacent fintech. System
  font stack, tabular numerals for all figures, right-aligned numeric columns,
  compact row height, green/red only for signed changes.
- Every number formatted: $1.24B / 12.4M shares / 3.21%. Nulls render as "—",
  never "null", "NaN", or 0.
- Loading skeletons per tab; empty states with one-line explanations;
  errors show a retry, never a blank page.
- Server components for data fetch; client components only where interactivity
  requires (table controls, tabs, charts).

## Acceptance criteria — Playwright (`e2e/`, write these FIRST)
- Fund page loads Berkshire seed data; header shows expected portfolio value.
- Clicking market-value header re-sorts descending (first row = largest).
- Pagination to page 2 changes rows; URL reflects state (deep-linkable).
- Column menu hides "Sector"; column disappears.
- Export CSV downloads; file row count matches holdings count.
- Quarter selector switches quarters; a status badge NEW is visible.
- Stock page insiders tab renders a P badge and an S badge from seed data.
- Confluence chart SVG renders with ≥1 bar and ≥1 marker.
- 404 route for unknown fund slug renders the not-found state.
- `typecheck`, `lint`, `test`, `e2e` all clean.

## Human gate checklist (visual, ~20 min)
Screenshots or a local click-through: table readability at 25 rows, badge
colors, chart legibility, mobile at 390px (tables scroll horizontally,
nothing overflows), dark-on-light contrast.

## Out of scope
Auth, watchlists, backtesting, WhaleScore-style rankings.
