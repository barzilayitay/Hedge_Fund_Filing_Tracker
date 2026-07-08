# Phase 3 — Form 4 ingestion (the differentiator)

## Objective
Parse Form 4 ownershipDocument XML into normalized insider-transaction data,
with derived signal views: cluster buys, insider sentiment, and fund
real-time activity.

## Prerequisites
Phase 1 complete (shares `filings`, `companies` tables). Independent of Phase 2.

## Deliverables
1. **Migrations**: `insiders`, `insider_relationships`, `form4_transactions`
   (columns per ARCHITECTURE.md; footnotes stored as jsonb keyed by footnote id).
2. **Parser** `lib/edgar/parseForm4.ts`:
   - Handles multiple `reportingOwner` blocks (joint filings) — one
     transaction row per (owner, transaction).
   - Parses both `nonDerivativeTable` and `derivativeTable`; derivative rows
     carry underlying security, conversion price, exercise/expiry dates.
   - Captures: transactionCode, transactionDate, shares, pricePerShare
     (nullable — gifts/awards often omit), acquiredDisposedCode,
     sharesOwnedFollowingTransaction, directOrIndirectOwnership +
     natureOfOwnership, `aff10b5One` flag, footnote references resolved to text.
   - Holdings-only rows (no transaction, position statements) are skipped but
     counted in parser stats.
3. **Loader** `lib/edgar/loadForm4.ts`: idempotent upsert on
   (accession_no, owner_cik, table_type, row_index).
4. **Derived views** (migration):
   - `insider_cluster_buys`: companies where ≥3 distinct insider_ciks have
     code-P transactions within any rolling 30-day window; expose window
     start/end, insider count, total value.
   - `insider_sentiment`: per company, trailing-90-day open-market
     (P and S only, exclude is_10b5_1 sales from the "bearish" count but
     report them separately) buy count, sell count, net value.
   - `fund_realtime_activity`: form4_transactions joined to `filers` on
     owner cik — the 10%-owner-fund feed.
5. Fill `fixtures/form4/*.expected.json`: per filing — transaction count,
   and full field set for 2 spot-check transactions.

## Implementation notes / pitfalls
- Amounts can carry footnote references instead of values
  (`<value>` absent, `<footnoteId>` present) — store null + footnote, never 0.
- Transaction code A (award) with price 0 is normal; do not coerce null price
  to 0 or 0 to null — they mean different things.
- Dates are `<value>` children, not text content of the parent element.
- Entity owners have `rptOwnerName` but no individual name parts — handle both.
- Form 4/A amendments: supersede by accession linkage same as Phase 1 pattern.

## Acceptance criteria (tests in `tests/phase3/`)
- Every Form 4 fixture parses; counts + spot checks match expected files.
- Codes P, S, M, A, G each verified on at least one fixture transaction.
- Derivative-table fixture yields derivative rows with underlying + expiry.
- 10b5-1 fixture row has is_10b5_1 = true.
- Entity-owner fixture links to the matching `filers` row and appears in
  `fund_realtime_activity`.
- Synthetic cluster test: seed 3 insiders buying within 30 days → company
  appears in `insider_cluster_buys`; 2 insiders → does not.
- Idempotency: double-load leaves state identical.
- `typecheck`, `lint`, full `test` clean.

## Out of scope
Form 3/5 (later enhancement), 13D/G parsing (stub the table, fill later), UI.
