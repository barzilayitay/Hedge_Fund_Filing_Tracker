# Phase 0 — Foundation & scaffold

## Objective
A fully scaffolded repo where every later phase can run autonomously:
toolchain, CI, hooks, local Supabase, and committed EDGAR fixtures.

## Human prerequisites (do these BEFORE running the kickoff prompt)
- [ ] GitHub repo created, this kit committed to `main`
- [ ] Supabase account + a dev project created; note project ref, anon key, service key
- [ ] Vercel account (used in Phase 7 only)
- [ ] OpenFIGI API key (free) — https://www.openfigi.com/api
- [ ] Docker installed locally (for `supabase db reset`)
- [ ] Claude Code installed, Supabase MCP connected, auto mode available
- [ ] Create `.env` from `.env.example` once Claude generates it; set
      `EDGAR_USER_AGENT="<AppName> <your-email>"`

## Claude deliverables
1. Next.js 15 + TypeScript strict scaffold (app router), ESLint, Prettier.
2. Vitest + Playwright configured; `npm run` scripts exactly as listed in CLAUDE.md.
3. `supabase init` with local config; empty first migration to prove the pipeline.
4. `lib/edgar/client.ts`: fetch wrapper with User-Agent from env, token-bucket
   rate limiter (8 req/s), retry with backoff on 429/403/5xx.
5. `scripts/fetch-fixtures.ts` (`npm run fixtures`): downloads and commits
   - 13F: Berkshire Hathaway (CIK 0001067983) two consecutive quarters;
     Pershing Square (0001336528) one quarter; one small filer (<50 positions);
     one 13F-HR/A RESTATEMENT pair (original + amendment); one 13F-HR/A
     NEW HOLDINGS pair; one pre-2023 filing (thousands-unit test case).
   - Form 4: ~20 filings covering codes P, S, M, A, G; at least one with
     a derivative table; at least one with the 10b5-1 flag set; at least one
     filed by an entity (10% owner fund), not a person.
   Each fixture gets a sibling `*.expected.json` stub (filled in Phase 1/3).
6. `.github/workflows/ci.yml`: on PR → install, typecheck, lint, test, build;
   Playwright job runs on PRs labeled `e2e` (cheap default, full check when needed).
7. `.env.example` documenting every required variable.
8. `PROGRESS.md` updated; Phase 0 marked complete.

## Acceptance criteria
- `npm run typecheck`, `lint`, `test` all pass on a fresh clone.
- `supabase db reset` succeeds locally.
- `fixtures/` contains all files listed above; a vitest smoke test asserts each
  fixture exists and is non-empty XML.
- Rate-limiter unit test: 20 queued requests never exceed 8 in any 1s window
  (use fake timers; no real network).
- CI workflow passes on a test PR.

## Out of scope
Any parsing logic, any schema beyond the empty migration, any UI.
