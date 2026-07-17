# PROGRESS.md — Build state

This file is the single source of truth for build status across Claude Code
sessions. Claude: update it at the end of every phase (and on interruption).
Human: read it before every gate review.

## Phase status

| Phase | Status | Branch | Gate reviewed |
|---|---|---|---|
| 0 — Foundation | AWAITING GATE | phase-0 | — |
| 1 — 13F ingestion | AWAITING GATE | phase-1 | — |
| 2 — Analytics | NOT STARTED | — | — |
| 3 — Form 4 ingestion | NOT STARTED | — | — |
| 4 — API | NOT STARTED | — | — |
| 5 — Frontend | NOT STARTED | — | — |
| 6 — Ops / scheduling | NOT STARTED | — | — |
| 7 — Deploy | NOT STARTED | — | — |

Statuses: NOT STARTED / IN PROGRESS / BLOCKED / AWAITING GATE / DONE

## Current phase notes

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

5. **`npx supabase db reset` was not run — Docker Desktop is not running on
   this machine** (`docker info` fails to connect). The migration is executed
   in full on every test run against Postgres 18 via PGlite, so the DDL is
   known-good, but it has not been applied by the Supabase CLI against
   Supabase's own Postgres. Please run it once (see the Windows section of
   CLAUDE.md for the required `-x` flags).

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
- The `Sql` port has only a PGlite implementation (tests). Phase 4/6 needs a
  production implementation against Supabase Postgres.
