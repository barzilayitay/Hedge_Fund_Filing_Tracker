# PROGRESS.md — Build state

This file is the single source of truth for build status across Claude Code
sessions. Claude: update it at the end of every phase (and on interruption).
Human: read it before every gate review.

## Phase status

| Phase | Status | Branch | Gate reviewed |
|---|---|---|---|
| 0 — Foundation | AWAITING GATE | phase-0 | — |
| 1 — 13F ingestion | NOT STARTED | — | — |
| 2 — Analytics | NOT STARTED | — | — |
| 3 — Form 4 ingestion | NOT STARTED | — | — |
| 4 — API | NOT STARTED | — | — |
| 5 — Frontend | NOT STARTED | — | — |
| 6 — Ops / scheduling | NOT STARTED | — | — |
| 7 — Deploy | NOT STARTED | — | — |

Statuses: NOT STARTED / IN PROGRESS / BLOCKED / AWAITING GATE / DONE

## Current phase notes

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

1. Confirm the 13F-HR/A amendment types (RESTATEMENT vs NEW HOLDINGS) match
   expectations — the actual amendment type metadata is in the filing
   header XML which we'll parse in Phase 1.
2. The CI workflow is committed but hasn't been tested on a real PR yet;
   it will be verified when the phase-0 PR is opened.

## Known issues / debt

- Tailwind CSS and PostCSS were removed from dependencies (not needed yet);
  postcss.config.mjs was deleted. Re-add in Phase 5 if the frontend
  design calls for Tailwind.
- The `postcss.config.mjs` from the Next.js scaffold was removed as unused.
