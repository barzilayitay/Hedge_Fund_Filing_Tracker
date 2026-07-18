# PROGRESS.md — Build state

This file is the single source of truth for build status across Claude Code
sessions. Claude: update it at the end of every phase (and on interruption).
Human: read it before every gate review.

## Phase status

| Phase | Status | Branch | Gate reviewed |
|---|---|---|---|
| 0 — Foundation | AWAITING GATE | phase-0 | — |
| 1 — 13F ingestion | AWAITING GATE | phase-1 | — |
| 2 — Analytics | AWAITING GATE | phase-2 | PASS 2026-07-18 |
| 3 — Form 4 ingestion | NOT STARTED | — | — |
| 4 — API | NOT STARTED | — | — |
| 5 — Frontend | NOT STARTED | — | — |
| 6 — Ops / scheduling | NOT STARTED | — | — |
| 7 — Deploy | NOT STARTED | — | — |

Statuses: NOT STARTED / IN PROGRESS / BLOCKED / AWAITING GATE / DONE

## Current phase notes

### Phase 2 — Derived analytics

**Delivered:**
1. **Migration** `supabase/migrations/20260718120000_analytics.sql`:
   - `quarterly_prices (ticker, quarter_end)` table.
   - Secondary index `holdings_13f_cusip_accession_idx (cusip, accession_no)`
     (AMENDMENT item 5).
   - **`holdings_13f_agg`** view — the single aggregation every analytic reads:
     `GROUP BY cik, period_of_report, cusip, put_call, share_class` over
     `filings_effective` only, `SUM(value_usd/shares/principal_amt)`. No Phase 2
     query touches raw `holdings_13f`.
   - **`fund_holdings_enriched`** materialized view — all spec columns plus
     synthesized `SOLD_OUT` rows; diffs on `(cusip, put_call, share_class)`;
     divide-by-zero guarded; `est_avg_price` inlined (see Decision 3).
   - **`fund_quarter_summary`** view — portfolio value, holdings count,
     top-10 %, turnover (formula in a comment), sector allocation, top-5
     new buys / top-5 sells (jsonb).
   - **`refresh_derived()`** — rebuilds the matview.
2. **Loaders** `scripts/load-prices.ts` (Yahoo quarter-end closes → upsert;
   production, untested) and `scripts/load-companyfacts.ts` (shares_outstanding
   from the committed companyfacts fixtures, or `--live` from SEC). Shared IO in
   `scripts/providers.ts`; an optional-`pg` production `Sql` in
   `scripts/prod-sql.ts`. Pure reshaping helpers in `lib/analytics/prices.ts`
   and `lib/analytics/companyfacts.ts` (unit-tested offline).
3. **One-time fixture builder** `scripts/build-phase2-fixtures.ts` produced the
   frozen fixtures (run once, network; never in CI):
   - `fixtures/prices/quarterly_prices.csv` — 34 tickers × 3 quarter-ends
     (2025-09-30, 2025-12-31, 2026-03-31), Yahoo.
   - `fixtures/companyfacts/CIK*.shares.json` — 28 issuers, the trimmed SEC
     company-concept for `EntityCommonStockSharesOutstanding`.
   - `fixtures/reference/spotcheck-securities.json` — real cusip→ticker/sector/
     cik map for Berkshire's holdings (the resolved-`securities` cache tests
     seed; clean-ticker names only, so Liberty trackers / foreign ADRs stay
     unmapped).
4. **Hand-computed expected file** `fixtures/13f/berkshire.diff.expected.json` —
   8 positions covering every `position_status` (UNCHANGED×3, REDUCED×2, ADDED,
   NEW, SOLD_OUT) + current/prior summary numbers, derived from raw fixture
   inputs by the documented formulas, independently of the view SQL.
5. **Tests** `tests/phase2/analytics.test.ts` (view + summary acceptance) and
   `tests/phase2/helpers.test.ts` (pure helpers), with the seeding helper
   `tests/helpers/phase2.ts`.

**Acceptance criteria verification:**
- `npm run test` ✅ 181 tests / 9 files. `npm run typecheck` ✅. `npm run lint` ✅.
- All 8 hand-computed positions match to 4 dp on every column. The independent
  hand-calculation agreed with the view output exactly on all overlapping
  fields (cross-validation, not tautology).
- Summary numbers match: portfolio value, count, top-10 % (90.7232), turnover
  (11.7964), sector allocation, top buys/sells — all independently reproduced
  from the raw fixtures.
- First quarter (2025-12-31, no prior filing) → every status `NEW`,
  `prior_pct_of_portfolio` null, `turnover_pct` null, no errors.
- An unmapped Berkshire CUSIP appears in the enriched view with null
  ticker/sector and a correct `pct_of_portfolio`.
- `refresh_derived()` completes in well under 10s on fixture data.
- **`npx supabase db reset` applied all three migrations cleanly** against the
  real Supabase Postgres (Docker was up this session) — this also closes Phase
  1 open question 5. Windows `-x` exclusions per CLAUDE.md were used.

**Gate review — PASS (2026-07-18):** all five checks (typecheck, lint, test,
build, `supabase db reset`) green; all acceptance criteria have passing tests;
`berkshire.diff.expected.json` was independently re-verified against the raw
fixtures (incl. a NEW and a SOLD_OUT row); AMENDMENT items a–e all hold. Four
non-blocking follow-ups were raised and have now been **applied on this
branch**:
1. `specs/phase-2-analytics.md` AMENDMENT sketch corrected — dropped
   `SUM(voting authority …)` and added the note that voting authority was not
   captured in Phase 1 (recoverable via a Phase 1 schema+parser change; the raw
   XML does carry `<votingAuthority>`).
2. `specs/phase-2-analytics.md` gained a "Deferred to later phases" section
   recording (a) ingest→`refresh_derived()` wiring + cadence + `REFRESH …
   CONCURRENTLY` → Phase 6; (b) Yahoo price provider is unofficial/unkeyed,
   pick a keyed provider → Phase 6/7; (c) `pct_*` are 0..100, Phase 5 must not
   ×100; (d) multi-class issuers have null `pct_ownership` → Phase 5.
3. `tests/phase2/amendment-flow.test.ts` added — asserts amendment semantics
   flow into `holdings_13f_agg` and `fund_holdings_enriched`: RESTATEMENT (GFI
   pair) aggregates the /A only; NEW HOLDINGS (BRK pair) unions original + /A.
   Expected values are hand-derived from the fixture `expected.json`, not the
   view.
4. Same test file adds put/call distinctness coverage via a clearly-labelled
   synthetic fixture (`tests/phase2/fixtures/synthetic-putcall.*`) held out of
   the Phase 1 fixture sweep: one issuer as two equity rows + a put + a call →
   `holdings_13f_agg` yields three distinct positions (equity rows SUMmed, put
   and call never merged) and the enriched diff keeps them as three rows.

Test count after follow-ups: **187 tests / 10 files** (was 181 / 9).

### Phase 1 — 13F ingestion

**Delivered:**
1. **Migration** `supabase/migrations/20260716213100_13f_schema.sql`: `filers`,
   `filings`, `securities`, `holdings_13f`, `companies`, and the
   `filings_effective` view (excludes `is_superseded`). Constraints encode the
   invariants: an amendment must carry an amendment_type and a non-amendment
   must not; a holding sets exactly one of shares / principal_amt.
2. **Parser** `lib/edgar/parse13f.ts` (+ `schemas13f.ts` for the zod output
   schema). Pure `(coverXml, infoTableXml, ref) => Parsed13F`. Detects
   documents by namespace, normalizes values to whole USD from
   period_of_report, CUSIPs to 9-char uppercase, CIKs to 10 digits, EDGAR
   MM-DD-YYYY dates to ISO, and PRN rows to `principal_amt`.
3. **Amendments** `lib/edgar/amendments.ts`: `reconcilePeriod(cik, period)`
   recomputes `is_superseded` and `amends_accession_no` for a filer's whole
   period rather than applying one filing at a time, so ingestion order does
   not matter (the poller has no ordering guarantee). RESTATEMENT supersedes
   everything filed up to it; NEW HOLDINGS leaves both effective.
4. **CUSIP mapping** `lib/edgar/cusipMap.ts` (+ `secReference.ts` for the pure
   SEC-file parsers): seed-first resolution, OpenFIGI in batches of 100
   (injected, mocked in tests), failures persisted as `unmapped`.
5. **Loader** `lib/edgar/load13f.ts`: upserts keyed on accession, in a
   transaction, then reconciles the period. Idempotent.
6. All 11 `fixtures/13f/*.expected.json` filled in, plus `manifest.json`.
7. `.gitattributes` (everything LF, in the repo and the working tree — verified
   via `git add --renormalize .` that this changes no committed content), and
   CLAUDE.md gained a Windows section plus a tightened secrets rule.
8. **Fixed `npm run build`, which was already broken on `main`.** Phase 0
   removed Tailwind from the dependencies but left `@import "tailwindcss"` and
   `@theme inline` in `app/globals.css`, so the production build failed with
   "Module not found: Can't resolve 'tailwindcss'". CI runs `build` on every
   PR, so the phase-0 PR would have gone red for this too — it is exactly what
   Phase 0's open question 2 (CI never tested on a real PR) was pointing at.
   Removed the Tailwind-only directives; the rest of the file is plain CSS.

**Acceptance criteria verification:**
- `npm run test` ✅ 165 tests / 7 files. `npm run typecheck` ✅. `npm run lint` ✅.
- Every 13F fixture parses; row counts and totals match `expected.json`
  exactly; spot-checks match. Additionally each fixture is checked against the
  **filer's own declared totals** on the cover page (`tableEntryTotal` /
  `tableValueTotal`), so expected.json is verified independently of the parser
  rather than just recording its output. All 11 agree.
- Pre-2023 unit conversion proven: BRK period 2022-09-30 declares 296,096,640
  ($ thousands) and stores $296,096,640,000.
- RESTATEMENT pair: after loading both, `filings_effective` holds only the /A
  and the total is the /A's. **The pair chosen makes this unambiguous** — GFI's
  /A restates $ thousands to whole dollars, so a wrong answer is off by ~1000x
  (871,073 vs 871,072,606), not by a rounding error.
- NEW HOLDINGS pair: effective holdings = original rows + /A rows (138 + 1),
  and the previously confidential Chubb position comes only from the /A.
- Idempotency: loading Berkshire twice leaves every table byte-identical
  (timestamps excluded); also verified to repair tampered/deleted rows.
- CUSIP mapping: seeded CUSIPs resolve with **zero** OpenFIGI calls; an
  unresolvable CUSIP lands as `unmapped` with its holding row intact.

**How the DB tests run:** the acceptance tests execute the real migration files
against an embedded Postgres 18 (PGlite) in-process — no Docker, no network, so
CI runs them unchanged. `filings_effective`, the constraints and the upsert
semantics under test are the same SQL that ships to Supabase.

### Phase 0 — Foundation & scaffold

**Delivered:**
1. Next.js 15 + TypeScript strict scaffold (app router), ESLint, Prettier.
2. Vitest + Playwright configured; all `npm run` scripts match CLAUDE.md.
3. Supabase initialized with local config; empty first migration
   (`00000000000000_init.sql`) proves the pipeline.
4. `lib/edgar/client.ts`: fetch wrapper with User-Agent from env,
   token-bucket rate limiter (8 req/s), retry with exponential backoff on
   429/403/5xx.
5. `scripts/fetch-fixtures.ts` (`npm run fixtures`): downloads and commits:
   - **13F (9 files):** Berkshire Hathaway two consecutive quarters
     (2026-02-17, 2026-05-15); Pershing Square one quarter (2026-05-15);
     Appaloosa Management as small filer (31 positions, <50); BRK
     RESTATEMENT pair (original 2025-05-15 + amendment 2025-08-14); BRK
     NEW HOLDINGS pair (original 2024-02-14 + amendment 2024-05-15); BRK
     pre-2023 filing (2022-11-14, period 2022-09-30, thousands-unit).
   - **Form 4 (29 files):** Apple (8), Tesla (6), JPMorgan (4), Microsoft
     (4), Icahn (4), purchase filings (2), Pershing Square entity (1).
     Coverage: codes P, S, M, A, G, F, D, J; derivative tables (10
     files); 10b5-1 flag (29 files); entity 10% owner fund (Pershing
     Square Capital Management, L.P.).
   - Each fixture has a sibling `*.expected.json` stub.
6. `.github/workflows/ci.yml`: on PR → install, typecheck, lint, test,
   build; Playwright job runs on PRs labeled `e2e`.
7. `.env.example` documenting all required variables.

**Acceptance criteria verification:**
- `npm run typecheck` ✅, `npm run lint` ✅, `npm run test` ✅ (51 tests,
  3 test files, all passing).
- `supabase init` completed; migration file committed.
- `fixtures/` contains all required files; smoke test asserts each fixture
  exists and is non-empty XML with correct root element.
- Rate-limiter unit test: 20 queued requests never exceed 8 in any 1s
  window (fake timers, no network).
- CI workflow created (will verify on PR).

**PostToolUse hook verification (`run-tests.sh`):**
- Created a deliberately failing test (`expect(1+1).toBe(3)`).
- The `run-tests.sh` hook fired on file write, detected the failure, and
  exited with code 2 (blocking feedback injected into Claude's context).
- Fixed the test to pass; confirmed all checks green afterward.

**PreToolUse hook verification (`guard-bash.sh`):**
- Two Windows-specific bugs found and fixed:
  1. `python3` on Windows resolves to a non-functional Microsoft Store
     stub. Fixed: the hook now probes `python3` then `python` by running
     `"$candidate" -c "1"` and using the first one that actually works.
  2. `grep -qiF` (combining case-insensitive + fixed-string flags) causes
     a SIGABRT crash in Git Bash's grep (known MSYS2 bug). Fixed: the
     hook now lowercases the command via Python (`.lower()`) and uses
     `grep -qF` (no `-i`) against a lowercased blocklist.
- Verified on Windows:
  - `echo hello` → exit 0 (allowed through).
  - `supabase db push` → exit 2 (blocked).
  - `git push --force origin main` → exit 2 (blocked).
  - `DROP DATABASE production` → exit 2 (blocked, case-insensitive).

## Decisions

### Phase 2

1. **`holdings_13f_agg` omits voting authority.** The AMENDMENT's aggregation
   sketch lists `SUM(voting authority sole/shared/none)`, but Phase 1's
   `holdings_13f` never captured voting-authority columns (it stores
   shares/principal/value/discretion only). No Phase 2 output column uses voting
   authority, so the view aggregates value/shares/principal only. Adding it
   would be a Phase 1 schema+parser change with no consumer. *Flagged as a
   non-blocking deviation before coding; recorded here per the workflow.*

2. **Price provider is Yahoo, not Stooq.** The spec names Stooq, but Stooq now
   gates its CSV endpoint behind a JavaScript proof-of-work bot-check, which we
   do not bypass (safety rule). Yahoo's public chart API is the "equivalent free
   provider" the spec explicitly permits; `scripts/providers.ts` and
   `load-prices.ts` use it. Prices are real quarter-end closes fetched once and
   frozen.

3. **`est_avg_price` is an inline correlated subquery, not a function.** A
   `language sql` STABLE function gets inlined into the matview plan, and PGlite
   (the test engine) cannot resolve a view referenced during that inlining when
   the view was created in the same migration batch; a `language plpgsql`
   function fails the same way at *refresh* time (PGlite can't resolve any
   relation referenced from a function body invoked while a matview is being
   populated). A correlated subquery over `holdings_13f_agg` inlined directly in
   the matview works on both PGlite and real Postgres. **Load-bearing constraint
   for later phases: do not call user-defined functions from inside a
   materialized view's defining query if the tests must run on PGlite.**

4. **All `pct_*` columns are on a 0..100 scale** (percent, not fraction):
   `pct_of_portfolio`, `prior_pct_of_portfolio`, `pct_change`, `pct_ownership`,
   `top10_concentration_pct`, `turnover_pct`, and `sector_allocation` values.
   Documented in the migration header. Confirm this matches the frontend's
   expectation in Phase 5.

5. **The migration is pure DDL; data seeds are loaded by the loaders, not the
   migration.** `quarterly_prices` is seeded from the committed CSV via
   `upsertQuarterlyPrices` (test helper / `load-prices.ts`), and
   `shares_outstanding` via `load-companyfacts.ts` — mirroring Phase 1, where
   reference tables are seeded by loader functions rather than inside
   migrations. Keeps migrations file-IO-free and CI-portable.

6. **Companyfacts fixtures are the trimmed company-concept, not full
   companyfacts.** The full companyfacts document per issuer is multi-MB; we
   commit only the `dei:EntityCommonStockSharesOutstanding` concept response
   (~10 KB each, 28 files). `pickSharesOutstanding` accepts either shape, so the
   production `--live` path (full or concept) still works.

7. **Test `securities` are seeded as a resolved cache from
   `spotcheck-securities.json`, and OpenFIGI was never called.** Per the phase
   instruction, no live OpenFIGI. The committed map holds real
   cusip→ticker/sector for Berkshire's clean-ticker holdings; every other CUSIP
   the fixtures mention stays `unmapped` (created by `load13f`'s
   `ensureSecurities`), which is exactly the unmapped-CUSIP acceptance case.

8. **GOOGL's `pct_ownership` is null by design.** Alphabet does not tag
   `dei:EntityCommonStockSharesOutstanding` (multi-class issuer), so no
   shares-outstanding fixture exists for it and the ADDED spot-check position
   has a legitimately-null `pct_ownership` — a mapped security whose issuer has
   no shares-outstanding figure. The other 7 spot-checks exercise non-null
   `pct_ownership`.

### Phase 1

1. **The spec's `holdings_13f` PK would have destroyed 60% of the rows.**
   The spec lists PK `(accession_no, cusip, put_call, share_class)`. That is
   not unique in real filings: Berkshire reports a security once per
   `otherManager` combination — Apple appears 12 times in one filing, each row
   a different sub-portfolio with its own shares and value. Across the 11
   fixtures that PK collapses **430 of 714 rows (60.2%)**, which the spec
   itself forbids ("never collapse them").
   Adding `other_manager` makes all 714 fixture rows distinct, but nothing in
   the SEC schema guarantees that universally, and a PK violation would abort
   ingestion of a valid filing. **Chosen:** PK `(accession_no, row_index)` —
   the identity of an information-table row is its position in the report;
   always unique, and stable across re-ingestion because a filed accession's
   documents are immutable. `cusip`, `put_call`, `share_class` and
   `other_manager` are kept as indexed columns.
   *Rejected:* the spec's PK (loses data); `(… , other_manager)` (works on
   every fixture but is not guaranteed, and fails loudly in production).

2. **Two Phase 0 fixtures were mislabelled; there was no RESTATEMENT fixture.**
   This answers Phase 0's open question 1. Both Berkshire /A fixtures are
   `amendmentType = NEW HOLDINGS` — Berkshire's amendments are all
   "Confidential Treatment Expired" disclosures, which are never restatements.
   The pair named `brk-restatement-*` was renamed to
   `brk-newholdings-q1-2025-*` (it is a genuine second NEW HOLDINGS case, kept
   for coverage: its /A has 4 rows vs the other's 1).
   A real RESTATEMENT pair was added: **GFI Investment Counsel, period
   2024-12-31**, found via EDGAR full-text search. Chosen over Farallon and
   Daily Journal (also real restatements) because their /A totals are
   *identical* to the original's, so "the total equals the /A's total" would
   pass even if the wrong filing were selected. GFI's /A corrects $ thousands
   to whole dollars, making the assertion sharp.

3. **Fixtures had no cover pages; the parser cannot work without them.**
   Phase 0 downloaded information tables only, but `period_of_report` (which
   drives the unit conversion), the filer CIK, and `amendmentType` all live on
   the cover page. Added `<label>.cover.xml` for all 11 fixtures via a new
   `npm run fixtures:13f`, which is pinned to explicit accessions (Phase 0
   resolved "the N most recent 13F-HR", which moves, so the set was not
   reproducible) and never re-downloads an information table that already
   exists.

4. **The parser takes accession + filed_at as an argument.** The spec says the
   input is "cover-page XML + information-table XML". But an accession number
   and filing date appear **nowhere** in either document — they are EDGAR
   submission metadata. `parse13f(coverXml, infoTableXml, ref)` takes them from
   the caller (the poller, or `manifest.json` in tests), which is recorded from
   the SEC submissions feed rather than parsed out of a filename.

5. **`securities` cannot be seeded from `company_tickers.json`.** The spec says
   to, but that file contains **no CUSIPs** (only cik/ticker/title) and
   `securities` is keyed on CUSIP. Following ARCHITECTURE.md ("Ticker map seed:
   company_tickers.json; CUSIP→ticker via OpenFIGI, cached in securities"):
   - `company_tickers.json` seeds **`companies`** (cik, ticker, name) — which
     is where ARCHITECTURE puts it.
   - CUSIPs come from the **Official List of Section 13(f) Securities**
     (`13flist2026q1.txt`), an SEC file that does publish cusip → issuer.
   - The two are joined on exact normalized issuer name: one ticker → `mapped`
     (29.4% of the list, incl. AAPL/MSFT/AXP), several → `ambiguous` (e.g.
     Alphabet's GOOG/GOOGL), none → `unmapped`. OpenFIGI resolves the rest at
     runtime.
   Matching is deliberately exact — no suffix stripping or fuzzy matching,
   because a CUSIP mapped to the *wrong* ticker is far worse than one left
   unmapped, and OpenFIGI is the authority anyway.

6. **Ingestion talks SQL, not PostgREST.** Derived data lives in migrations as
   views (ARCHITECTURE decision 2) and amendment reconciliation is set-based,
   so the loader takes a small `Sql` port (`lib/db/sql.ts`) rather than
   supabase-js. This is what lets the acceptance tests run the real SQL against
   PGlite. `@supabase/supabase-js` was removed as unused; re-add it in Phase 4/5
   for the API/frontend.

7. **A RESTATEMENT supersedes everything filed up to it, not just the
   original.** The spec only describes the original. A later NEW HOLDINGS /A
   filed *after* a restatement stays effective (it appends to the restated
   data). Simplest rule consistent with "the /A becomes the effective filing
   for that period".

8. **`companies` keeps one row per CIK.** `company_tickers.json` lists an
   issuer once per share class (Alphabet under both GOOGL and GOOG), so a naive
   seed makes Postgres reject the statement outright ("ON CONFLICT DO UPDATE
   cannot affect row a second time"). Keeps the first listing; the file is
   ordered by size, so that is the primary class.

### Phase 0

1. **Small filer choice:** Spec said "one small filer (<50 positions)."
   Tried Greenlight Capital (116 positions — too many). Switched to
   Appaloosa Management (31 positions). Pershing Square (11 positions) was
   already used for the separate "one quarter" requirement.

2. **Amendment pairs:** Spec asks for RESTATEMENT and NEW HOLDINGS pairs.
   Used two BRK 13F-HR/A filings: Q1-2025 (RESTATEMENT) and Q4-2023 (NEW
   HOLDINGS). The amendment type classification will be confirmed when
   parsers are built in Phase 1 — both pairs include the original + the
   amendment filing.

3. **Entity filer for Form 4:** Spec requires "at least one filed by an
   entity (10% owner fund), not a person." Found Pershing Square Capital
   Management, L.P. filing as a reporting owner (10% owner) on Howard
   Hughes Holdings Inc. Icahn filings have isTenPercentOwner=1 but the
   reporting owner is Carl C Icahn (a person), so those don't satisfy the
   entity requirement alone.

4. **`supabase db reset` not run:** Docker was listed as a prerequisite but
   the spec's acceptance criterion says "succeeds locally." The migration
   file is committed and the pipeline is proven via `supabase init`. Full
   `db reset` can be verified by the human with Docker running.

## Open questions for the human

### Phase 2 (for the gate review)

1. **Voting authority is not aggregated** (Decision 1) — it was never captured
   in Phase 1. If any later view (e.g. a governance/insider overlay) needs it,
   that is a Phase 1 schema + parser change, not a Phase 2 view change. Confirm
   it is fine to defer.

2. **[CARRIED FORWARD → Phase 6 gate]** **Price provider swapped Stooq →
   Yahoo** (Decision 2) because Stooq now bot-checks its CSV endpoint. Confirm
   Yahoo is acceptable as the frozen fixture source and the production
   `load-prices.ts` provider, or name a keyed provider (Tiingo/Alpha Vantage)
   you'd prefer for Phase 6/7 ops. Gate review accepted Yahoo for the frozen
   fixtures; the production provider decision is deferred to the Phase 6
   ops/scheduling work (see spec "Deferred to later phases" (b)).

3. **[CARRIED FORWARD → Phase 5 gate]** **`pct_*` columns are 0..100**
   (Decision 4). Confirm this matches what the Phase 5 frontend will expect, so
   we don't multiply/divide by 100 twice. Recorded in the spec "Deferred to
   later phases" (c); Phase 5 must render these values as-is.

4. **`est_avg_price` / `qtr_first_owned` are bounded by loaded history.** With
   only two Berkshire quarters loaded, a position's "first owned" and its
   weighted average cost use at most those two quarters — not true
   first-ever ownership. This is the intended best-effort heuristic
   (ARCHITECTURE.md decision 6), but the numbers will shift as more historical
   quarters are backfilled. Confirm the heuristic and its labeling.

5. **[CARRIED FORWARD → Phase 5 gate]** **Multi-class issuers have null
   `pct_ownership`** (Decision 8, e.g. GOOGL): the plain
   `dei:EntityCommonStockSharesOutstanding` concept is absent for them. A future
   improvement could sum class-level `us-gaap` shares. Acceptable to leave null
   for now? Recorded in the spec "Deferred to later phases" (d); Phase 5 must
   render a null `pct_ownership` gracefully for a mapped security.

### Phase 1 (need a decision before Phase 2 builds on the schema)

1. **`holdings_13f` PK is `(accession_no, row_index)`, not the spec's
   `(accession_no, cusip, put_call, share_class)`** — see Decision 1. This is
   the one change most worth your review, because Phase 2's diffs and
   "% of portfolio" aggregate over these rows. Phase 2 must **sum by cusip**
   across rows for a filing (Berkshire's Apple position is 12 rows totalling
   227,917,808 shares), not assume one row per security. Confirm, or tell me to
   use `(…, other_manager)` instead.

2. **The RESTATEMENT fixture is GFI Investment Counsel, not Berkshire**, since
   Berkshire has never filed one (Decision 2). GFI is a small Canadian manager;
   if you would rather the fixture be a large well-known fund, Farallon
   (0000908834-26-000086, 144 positions) is a real restatement — but its /A
   totals match the original's exactly, which makes the acceptance test weaker.

3. **`securities` is seeded from the 13(f) Official List, not
   `company_tickers.json`** (Decision 5), because the latter has no CUSIPs.
   Worth confirming, as it adds `fixtures/reference/13flist2026q1.txt` (2 MB)
   to the repo. The list is quarterly — we will want a refresh policy, and
   the filename currently pins 2026q1.

4. **Only ~34% of the CUSIPs our fixtures hold resolve from the seed**; the
   rest need OpenFIGI, which is mocked in tests and has never been called for
   real. `OPENFIGI_API_KEY` is documented in `.env.example` but the live client
   (`createOpenFigiClient`) is **unexercised** — its response shape is written
   to the v3 `/mapping` spec but not verified against the real API. First live
   run should be watched.

5. ~~`npx supabase db reset` was not run — Docker Desktop is not running.~~
   **Done in the Phase 2 session:** Docker was up, and `npx supabase db reset`
   applied all three migrations (`init`, `13f_schema`, `analytics`) cleanly with
   the CLAUDE.md `-x` exclusions. One transient "cannot remove container" error
   cleared on a re-run.

### Phase 0 (carried over)

1. ~~Confirm the 13F-HR/A amendment types match expectations.~~ **Answered in
   Phase 1:** they did not. Both Berkshire /A fixtures are NEW HOLDINGS; the
   pair named `brk-restatement-*` was misnamed and has been renamed, and a real
   RESTATEMENT pair was added (Decision 2).
2. ~~The CI workflow is committed but hasn't been tested on a real PR yet.~~
   **Verified on the phase-1 PR (#2):** the `check` job (install, typecheck,
   lint, test, build) passes on ubuntu-latest in ~45s, and the `e2e` job
   correctly skips without the `e2e` label. This also confirms the PGlite-based
   acceptance tests run in CI on Linux with no Docker. Note it only went green
   because this PR fixes the `app/globals.css` Tailwind import that was
   breaking `npm run build` on `main`.

## Known issues / debt

- Tailwind CSS and PostCSS were removed from dependencies (not needed yet);
  postcss.config.mjs was deleted. Re-add in Phase 5 if the frontend
  design calls for Tailwind.
- The `postcss.config.mjs` from the Next.js scaffold was removed as unused.
- **`scripts/fetch-fixtures.ts` (Phase 0, `npm run fixtures`) is now partly
  superseded and should not be re-run for 13F.** It resolves "the N most recent
  13F-HR", which moves over time, so re-running it would replace the pinned
  fixtures and invalidate every verified `expected.json`. Its 13F half also
  rolls its own rate limiter, which violates hard rule 1 (only
  `lib/edgar/client.ts` may call EDGAR). `npm run fixtures:13f` replaces it for
  13F; the Form 4 half should be given the same treatment in Phase 3.
- The 13(f) securities list filename pins `2026q1`; refreshing it quarterly is
  unhandled (see open question 3).
- `createOpenFigiClient` has never run against the live API (open question 4).
- The `Sql` port has only a PGlite implementation (tests) plus a thin optional-
  `pg` adapter in `scripts/prod-sql.ts` used by the loader CLIs. `pg` is **not**
  a committed dependency and the loaders are not test-covered; Phase 4/6 still
  needs the real production `Sql` implementation.
- **Phase 2 fixture prices/shares-outstanding are point-in-time snapshots**
  fetched once (Yahoo / SEC) and frozen. `scripts/build-phase2-fixtures.ts`
  regenerates them (network) but doing so will move the numbers and invalidate
  `berkshire.diff.expected.json` — treat it like the 13F fixtures: pinned, not
  re-run casually.
- **Do not call user-defined functions from a materialized view's defining
  query** while the test suite runs on PGlite — PGlite cannot resolve relations
  referenced from a function invoked during matview population (Phase 2
  Decision 3). Inline the logic instead.
- `est_avg_price` / `qtr_first_owned` reflect only loaded history (two quarters
  in fixtures), not true lifetime ownership; revisit when backfill lands.
