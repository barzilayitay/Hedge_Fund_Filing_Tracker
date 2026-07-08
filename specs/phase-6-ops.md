# Phase 6 — Scheduling, ingestion in production, ops

## Objective
The system feeds itself: EDGAR polled continuously, new filings ingested
within minutes, failures visible.

## Prerequisites
Phases 1–4 complete. Phase 5 not required.

## Deliverables
1. **Poller** — Supabase Edge Function `poll-edgar`:
   - Reads the EDGAR daily index (and the current day's incremental index),
     filters form types 13F-HR, 13F-HR/A, 4, 4/A.
   - Diffs against `filings` by accession_no; fetches + ingests only new ones.
   - Batched, rate-limited via the shared client logic; hard cap per run
     (e.g., 200 filings) with cursor continuation so filing-deadline spikes
     (quarterly 45-day deadline days can bring thousands of 13Fs) drain over
     successive runs instead of timing out.
   - Writes an `ingestion_log` row per run; calls `refresh_derived()` when
     any 13F was ingested.
2. **Schedule**: pg_cron every 10 minutes invoking the edge function.
   Fallback documented: GitHub Actions cron calling the same function URL.
3. **Backfill** `scripts/backfill.ts --funds funds.txt --quarters 8 --form4-months 12`:
   resumable (cursor file), respects rate limits, logs progress. Include a
   starter `funds.txt` of 100 well-known filer CIKs.
4. **Alerting**: edge function `check-health` (daily cron) — emails (Resend
   free tier or Supabase SMTP) when: last successful poll > 60 min ago,
   error rate in last 24h > 5%, or unmapped-CUSIP count grew > 200 in a day.
5. **Admin view** `/admin/ingestion` (basic-auth env password): last runs,
   errors, unmapped CUSIP list with manual-map action.

## Acceptance criteria (tests in `tests/phase6/`)
- Poller unit tests with a mocked index: new accession ingested, known
  accession skipped, malformed filing logged as error without aborting the run.
- Cap/continuation test: 500 mock filings, cap 200 → three runs drain all,
  no duplicates.
- Health check fires on a synthetic stale-poll condition (mocked clock).
- Backfill resumability: kill after N filings, restart, final state complete
  with no duplicates (mocked fetch layer).
- One documented live smoke test (run manually at the human gate): poller
  executed once against real EDGAR ingests today's filings without error.
- `typecheck`, `lint`, full `test` clean.

## Out of scope
Full-universe historical backfill (decide later; it's tens of GB), N-PORT.
