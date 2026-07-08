# CLAUDE.md — Project instructions

## What this project is

A web application that tracks institutional investors via SEC 13F filings
(per-fund holdings pages with quarter-over-quarter analytics, replicating
WhaleWisdom's fund-page functionality) and extends it with Form 4 insider
transaction tracking (per-stock insider tables, cluster-buy detection, a
fund "real-time activity" view for 10%-owner funds, and a confluence view
overlaying institutional and insider activity).

All data comes directly from SEC EDGAR. We never scrape WhaleWisdom or any
third-party aggregator.

## Stack

- Next.js 15, App Router, TypeScript strict mode
- Supabase: Postgres, migrations, RPC functions, pg_cron, Edge Functions
- TanStack Table v8 (tables), Recharts (charts)
- Vitest (unit/integration), Playwright (e2e)
- Deployed on Vercel (app) + Supabase (data)

## Commands

```
npm run dev          # local dev server
npm run test         # vitest, single run
npm run test:watch   # vitest watch
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run e2e          # playwright (requires dev server or preview build)
npm run fixtures     # download/refresh EDGAR fixtures (network required; rarely run)
supabase migration new <name>   # create migration
supabase db reset               # rebuild local db from migrations + seed
```

## Hard rules (never violate)

1. **EDGAR fair access.** Every request to sec.gov must send the header
   `User-Agent: <AppName> <contact-email>` (values in `.env`), stay under
   8 requests/second (below the 10/s limit), and back off on HTTP 429/403.
   The rate limiter in `lib/edgar/client.ts` is the only permitted way to
   call EDGAR.
2. **Tests never hit the network.** All parser and analytics tests run
   against files in `fixtures/`. If a test needs new data, add a fixture,
   don't fetch live.
3. **Schema changes only via migrations.** Never execute DDL directly
   against any database. Local: `supabase migration new` + `supabase db
   reset`. Remote: migrations are applied by CI/human, not by you.
4. **Never touch production.** No commands against the production Supabase
   project or Vercel production environment unless the spec for the
   current phase explicitly says so (Phase 7 only).
5. **No secrets in code or commits.** Secrets live in `.env` (gitignored)
   and platform secret stores. `.env.example` documents required keys.
6. **Idempotent ingestion.** Every ingest path must be safe to re-run:
   upsert keyed on SEC accession number, never blind insert.
7. **Amendments are handled explicitly** (see `specs/phase-1`); never
   ingest a 13F-HR/A as if it were an independent filing.

## Workflow for every session

1. Read `PROGRESS.md`, then read the spec for the current phase in full.
2. Write a short plan (list of steps) before touching code.
3. Work test-first where the spec defines acceptance criteria: write or
   port the acceptance test, watch it fail, implement, watch it pass.
4. The PostToolUse hook runs the test suite after every edit — read its
   output and fix failures immediately; do not batch them.
5. A phase is done only when: all acceptance criteria in the spec pass,
   `npm run typecheck` and `npm run lint` are clean, and the full
   `npm run test` suite passes.
6. Finish by updating `PROGRESS.md` (phase status, what was built, any
   deviations from spec and why, open questions for the human gate) and
   committing with a conventional message (`feat(phase-1): ...`).
7. Stop after the current phase. Do not start the next phase in the same
   session, even if it seems easy.

## When the spec is ambiguous

Prefer the interpretation that is (a) simplest, (b) consistent with
`ARCHITECTURE.md`, and (c) reversible. Record the decision and the
alternative you rejected in `PROGRESS.md` under "Decisions". Only stop and
ask the human if the ambiguity is destructive or irreversible (data loss,
production, spending money).

## Repo layout

```
app/                  # Next.js routes (app router)
components/           # React components
lib/edgar/            # EDGAR client, parsers (13F, Form 4), index poller
lib/analytics/        # diff/summary computation helpers (SQL lives in migrations)
supabase/migrations/  # all DDL, in order
supabase/functions/   # edge functions (poller, alerts)
fixtures/13f/         # committed real 13F filings + expected-output JSON
fixtures/form4/       # committed real Form 4 XML + expected-output JSON
tests/                # vitest suites, one file per spec section
e2e/                  # playwright specs
specs/                # phase specs — the source of truth for scope
scripts/              # fixtures downloader, backfill, hooks
```

## Style

- TypeScript strict; no `any` except at parser boundaries with immediate
  narrowing via zod schemas.
- Parsers are pure functions: `(xmlString) => ParsedFiling`. IO stays in
  the client/poller layer.
- SQL for derived data lives in migrations as views/materialized views/RPC,
  not in application code.
- Keep files under ~300 lines; split before they grow past that.
