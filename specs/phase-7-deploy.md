# Phase 7 — Deploy & harden

## Objective
Production on Vercel + Supabase, with monitoring, and a nightly smoke test.
This phase touches production — the human runs the actual deploy commands;
Claude prepares everything and verifies.

## Prerequisites
All prior phases complete and merged.

## Deliverables
1. **Environment matrix** documented in `DEPLOY.md`: local / preview /
   production values for every `.env.example` key; which are Vercel env vars
   vs Supabase secrets.
2. **Production migration path**: `supabase db push` runbook with a
   pre-flight checklist (backup, diff review). Claude writes it; human runs it.
3. **Vercel config**: `vercel.json` if needed, ISR/caching policy —
   fund and stock pages revalidate on a 10-minute tag; export route uncached.
4. **Hardening pass**:
   - Error boundaries on every route segment.
   - `robots.txt`, sitemap for fund/stock pages, per-page metadata + OG tags.
   - Basic security headers (CSP report-only to start, frame-deny, nosniff).
   - Simple per-IP rate limit on the export route.
5. **Nightly smoke workflow** `.github/workflows/smoke.yml` against
   production: home loads, one fund page renders expected quarter, export
   returns 200 + CSV content-type, `/api/health` (add it) reports last-poll
   age < 60 min.
6. **Performance budget**: Lighthouse CI on the fund page — performance ≥ 85,
   no CLS regressions; documented, enforced in CI as warning (not blocking).
7. **Legal footer**: data source attribution ("Data: SEC EDGAR"), delay
   disclaimer, not-investment-advice note, link to source filing on every
   fund/stock page (accession-linked, like WhaleWisdom does).

## Acceptance criteria
- Preview deployment (Vercel preview + Supabase branch/dev project) passes the
  full Playwright suite pointed at the preview URL.
- Smoke workflow green against preview.
- Lighthouse report committed for the fund page.
- Human gate: run the production deploy runbook, then the smoke workflow
  against production, then trigger the backfill for the starter fund list.

## Out of scope
Custom domain/DNS specifics (human task), paid features, user accounts.
