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
  **DEFERRED.** As-built: Form 4/A filings load standalone (form_type '4/A',
  amendment_type null, is_superseded false). Supersession is deferred because
  the fixture set contains no original+amendment pair and ownershipDocument has
  no field linking a 4/A to its original accession. BINDING RULE for the phase
  that implements it (Phase 6 pre-go-live BLOCKER): link a 4/A to its original
  by (issuer_cik, owner_cik, period_of_report) and mark the original
  is_superseded, mirroring the Phase 1 reconcilePeriod pattern. Until
  implemented, ingesting an original Form 4 and its 4/A double-counts the
  amended transactions in insider_cluster_buys and insider_sentiment — the live
  poller MUST NOT go live before this lands.

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

## As-built notes (Phase 3 implementation)

These reflect the shipped implementation and accepted deviations. See
`PROGRESS.md` "Decisions → Phase 3" for the full rationale on each.

- **Shared `filings` table.** Form 4 filings land in `filings` with
  `form_type` '4'/'4/A', grouped under the **issuer** CIK. Two 13F-only
  constraints were relaxed to allow this: the `filings.cik → filers.cik`
  foreign key was **dropped** (13F managers and Form 4 issuers are disjoint CIK
  universes), and the amendment-type check was **re-scoped to 13F** (a Form 4/A
  does not carry the 13F `RESTATEMENT`/`NEW HOLDINGS` enum, so non-13F filings
  must leave `amendment_type` null). Every 13F-only read path was audited and
  already filters `form_type` (`holdings_13f_agg`, `reconcilePeriod`); the Form
  4 views read `form4_transactions` only.

- **Form 4/A supersession is deferred.** The one 4/A fixture
  (`purchase-bankwell`) has no matching original in the set and no acceptance
  criterion exercises supersession, so it loads as an ordinary filing. Form 4
  amendment reconciliation is left to the phase that needs it. See the DEFERRED
  binding rule under "Implementation notes / pitfalls" — this is a Phase 6
  pre-go-live BLOCKER because an original + its 4/A double-count until it lands.

- **Joint filings fan out to one row per owner×transaction.** Consequence: a
  joint P/S filing would count each owner as a distinct insider and sum the
  transaction value once per owner in BOTH `insider_cluster_buys` AND
  `insider_sentiment` (extending the existing PROGRESS Decision 6 note, which
  covers only the cluster view). No current fixture triggers this (the joint
  `psh-entity` filing is code A, excluded from both P/S views). Resolution
  deferred until a real joint P/S fixture exists.

- **`filings.cik → filers` FK was dropped (not re-scoped)** to admit Form 4
  rows whose grouping CIK is the issuer. Integrity for 13F rows is now
  loader-enforced only (`load13f` inserts the filer first). Follow-up: add a
  trigger-based guard for `form_type LIKE '13F-HR%'` rows when the production
  `Sql` path lands (Phase 4/6).

- **Null-price transactions contribute 0 to `total_value`/`net_value` sums**
  via `coalesce(price, 0)` in `insider_cluster_buys` and `insider_sentiment`
  (documented understatement, not a distortion — no `AVG` computations exist in
  the Form 4 views).

- **`form4_transactions` PK is `(accession_no, insider_cik, table_type,
  row_index)`** (the loader's idempotency key), not ARCHITECTURE's surrogate
  `id` — this makes replace-per-accession trivially idempotent without a churny
  surrogate. `row_index` is the transaction's position within its table_type,
  shared across a joint filing's owners.

- **`insider_sentiment` "trailing 90 days"** is measured from each company's
  most recent transaction (`as_of`), not wall-clock `now()`, so the view is
  deterministic over frozen fixtures.

- **Fixtures reused from Phase 0, re-pinned.** No new Form 4 documents were
  fetched. `scripts/fetch-fixtures.ts` was deleted and replaced by the pinned
  `scripts/fetch-form4-fixtures.ts` (`npm run fixtures:form4`). The committed
  `fixtures/form4/manifest.json` ships with **placeholder accessions** until a
  human runs that script; `tests/phase3/manifest.test.ts` gates on it (the suite
  stays red until real accessions are pinned).
