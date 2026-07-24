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
npm run fixtures:13f   # refresh 13F fixture docs + SEC reference data (network)
npm run fixtures:expected      # regenerate fixtures/13f/*.expected.json (offline)
npm run fixtures:form4         # re-pin Form 4 fixtures + write manifest.json (network)
npm run fixtures:form4:expected # regenerate fixtures/form4/*.expected.json (offline)
npx supabase migration new <name>   # create migration
npx supabase db reset               # rebuild local db from migrations + seed
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
   Any PR touching `supabase/migrations/**` must pass the Docker-gated
   **`Security (migrations)`** workflow (a required check) AND a human-run
   adversarial gate review before merge. That job exists because PGlite (the
   Docker-free test engine) cannot reproduce Supabase provisioning artifacts
   like `pg_default_acl`, so the standing PGlite security tests cannot catch a
   view-grant leak that only appears on real Supabase — origin: Phase 4 gate
   review #1. Do not weaken or delete it. See ARCHITECTURE.md "CI".
4. **Never touch production.** No commands against the production Supabase
   project or Vercel production environment unless the spec for the
   current phase explicitly says so (Phase 7 only).
5. **No secrets in code or commits.** Secrets live in `.env` (gitignored)
   and platform secret stores. `.env.example` documents required keys.
   Real credentials go **only** in `.env` — never in `.env.example`, which is
   committed and must contain placeholders only. Before committing any env
   file, run `git diff` on it and read the actual values.
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

## Windows environment

This project is developed on Windows. The following are not preferences —
they are the only ways these commands work here.

**Local Supabase must exclude the services that fail health checks on
Windows** (studio, storage-api and postgres-meta):

```
npx supabase start -x studio,storage-api,postgres-meta,imgproxy,logflare,vector,mailpit
```

**The Supabase CLI is a local project dependency, not a global binary.**
Always use the `npx` prefix: `npx supabase migration new`, `npx supabase db
reset`. A bare `supabase ...` will not resolve.

**Docker read-only or "image corrupted" errors:** fully restart Docker
Desktop, open a fresh terminal, then `docker rmi` and re-pull any image that
fails with a missing-binary error. Restarting the terminal alone is not
enough.

**Line endings** are settled by `.gitattributes` (everything is LF, in the
repo and the working tree). Never commit a diff that is only CRLF/LF churn —
if one appears, fix the attributes rather than staging the noise.

**The test suite needs no Docker.** The Phase 1 acceptance tests run the real
migrations against an embedded Postgres (PGlite), so `npm run test` works
with Docker stopped. Docker is only needed for `npx supabase start` / `db
reset`.

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
lib/db/               # SQL port used by the loaders
lib/edgar/            # EDGAR client, parsers (13F, Form 4), index poller
lib/analytics/        # diff/summary computation helpers (SQL lives in migrations)
supabase/migrations/  # all DDL, in order
supabase/functions/   # edge functions (poller, alerts)
fixtures/13f/         # committed real 13F filings + expected-output JSON.
                      #   <label>.xml = information table
                      #   <label>.cover.xml = cover page (primary_doc.xml)
                      #   manifest.json = accession + filed_at per fixture
fixtures/form4/       # committed real Form 4 XML + expected-output JSON
fixtures/reference/   # SEC reference data (company_tickers.json, 13(f) list)
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
