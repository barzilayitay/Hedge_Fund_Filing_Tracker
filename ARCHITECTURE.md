# ARCHITECTURE.md

## Data flow

```
SEC EDGAR (13F-HR XML, Form 4 XML, daily index)
        │  polled every 10 min (pg_cron → edge function; GH Actions cron as fallback)
        ▼
Ingestion worker (lib/edgar): rate-limited client → parsers → normalized rows
        │  upserts keyed on accession number (idempotent)
        ▼
Supabase Postgres: raw tables → views / materialized views (QoQ diffs, summaries,
                   cluster-buy, insider sentiment) → RPC functions
        │  PostgREST + RPC
        ▼
Next.js app: fund pages, stock pages, insider feed, confluence view
```

## Core schema (summary — DDL lives in migrations)

| Table | Key columns | Notes |
|---|---|---|
| `filers` | cik (PK), name, slug | 13F filers; slug for URLs |
| `filings` | accession_no (PK), cik, form_type, period_of_report, filed_at, amends_accession_no, amendment_type, is_superseded | one row per SEC filing, both 13F and Form 4 |
| `securities` | cusip (PK), ticker, name, sector, mapping_status | mapping_status: mapped / unmapped / ambiguous |
| `holdings_13f` | (accession_no, cusip, put_call, share_class) PK, shares, principal_amt, value_usd, investment_discretion | raw info-table rows |
| `companies` | cik (PK), ticker, name, shares_outstanding, shares_outstanding_asof | issuers, from SEC companyfacts |
| `insiders` | cik (PK), name | Form 4 reporting owners |
| `insider_relationships` | (insider_cik, company_cik), is_officer, is_director, is_ten_pct, officer_title | |
| `form4_transactions` | id PK, accession_no, insider_cik, company_cik, table_type (nonderiv/deriv), transaction_code, transaction_date, shares, price, acquired_disposed, shares_owned_after, direct_indirect, is_10b5_1, footnotes jsonb | |
| `quarterly_prices` | (ticker, quarter_end) PK, close_price | quarter-end closes, free source |
| `ingestion_log` | id, run_at, source, filings_found, filings_ingested, errors jsonb | |

Derived (views / matviews, refreshed after ingest):
- `fund_holdings_enriched` — holdings joined to securities, prices, prior quarter;
  computes % of portfolio, prior %, rank, change in shares, % change, % ownership,
  qtr first owned, estimated avg price.
- `fund_quarter_summary` — portfolio value, holding count, top-10 concentration,
  turnover, sector allocation, top new buys / top sells.
- `insider_cluster_buys` — ≥3 distinct insiders with code P in a 30-day window.
- `insider_sentiment` — trailing-90-day buy/sell counts and value per company.
- `fund_realtime_activity` — Form 4 + 13D/G rows where the reporting owner CIK
  matches a `filers.cik` (10%-owner funds).

## EDGAR reference (for parsers and poller)

- Daily index: `https://www.sec.gov/Archives/edgar/daily-index/{yyyy}/QTR{q}/form.{yyyymmdd}.idx`
- Full-text submissions per filer: `https://data.sec.gov/submissions/CIK{10-digit}.json`
- 13F-HR: filing directory contains a primary doc + `infotable.xml` (or an
  XML file matching the informationTable namespace). Columns per entry:
  nameOfIssuer, titleOfClass, cusip, value (in USD as of the 2023 rule change —
  verify per filing period; pre-2023 values are in $ thousands), sshPrnamt,
  sshPrnamtType (SH/PRN), putCall, investmentDiscretion, votingAuthority.
- Form 4: primary document is `ownershipDocument` XML with
  `nonDerivativeTable` and `derivativeTable`, `reportingOwner` blocks,
  `aff10b5One` flag, footnotes with id references.
- Company facts (shares outstanding): `https://data.sec.gov/api/xbrl/companyfacts/CIK{10-digit}.json`
  (dei:EntityCommonStockSharesOutstanding).
- Ticker map seed: `https://www.sec.gov/files/company_tickers.json`;
  CUSIP→ticker resolution via OpenFIGI API (free tier, batch of 100/request)
  with results cached in `securities`.
- Fair access: User-Agent with contact email on every request; ≤8 req/s;
  exponential backoff on 429/403.

## CI

Two workflows gate merges to `main`:

- **`CI`** (`.github/workflows/ci.yml`) — runs on every PR: typecheck, lint, the
  full `npm run test` suite, and `build`. Docker-free; the acceptance tests run
  the real migrations against embedded Postgres (PGlite).

- **`Security (migrations)`** (`.github/workflows/security-migrations.yml`) —
  runs **only on PRs that touch `supabase/migrations/**`** and is a **required
  check** for those PRs. It brings up the real Supabase stack (Postgres +
  PostgREST) via `supabase start` + `supabase db reset`, then asserts the anon
  attack surface both in the catalog (`scripts/ci/assert-anon-surface.sql`:
  execute-surface == the six RPCs; zero anon/public grants on any table/view/
  matview; RLS on every base table) and over the wire with the anon key
  (`scripts/ci/postgrest-smoke.sh`: the six RPCs reachable; `refresh_derived`
  and the five derived views denied).

  **Why it must exist and must not be deleted as CI cruft:** PGlite cannot
  reproduce Supabase provisioning artifacts — most importantly `pg_default_acl`,
  which auto-grants privileges (including `MAINTAIN`) to `anon` on owner-created
  relations. A view-grant leak that surfaces only on real Supabase is therefore
  invisible to the standing PGlite security tests. This job is the backstop for
  that class. Origin: **Phase 4 gate review #1** (BLOCKER-1/2), where exactly
  such a leak shipped.

  The job is a supplement, not a substitute: migration PRs still require the
  human-run adversarial gate review in a fresh session (see PROGRESS.md). The
  runner is Linux (ubuntu-latest); it applies the same `-x` service-exclusion
  list as CLAUDE.md's Windows command, which is safe there and still starts db +
  gateway + PostgREST.

## Key decisions

1. **Supabase over self-hosted Postgres** — pg_cron + edge functions remove a
   separate worker deployment; the Supabase MCP lets Claude Code manage
   migrations directly during development.
2. **Derived data as SQL views, not app code** — analytics defined once,
   testable with plain SQL fixtures, no drift between API and UI.
3. **Amendment model**: a 13F-HR/A with amendment_type RESTATEMENT supersedes
   the original (mark original `is_superseded`); NEW HOLDINGS appends to it.
   Queries always read through a `filings_effective` view that excludes
   superseded filings.
4. **Value-unit handling**: 13F `value` switched from $ thousands to whole
   dollars for periods ending on/after 2023-01-01 (SEC technical amendment).
   Normalize to whole USD at parse time based on period_of_report.
5. **Unmapped CUSIPs never block ingestion** — rows land with
   mapping_status='unmapped' and surface in an admin view for later resolution.
6. **Estimated avg price** is a best-effort heuristic (quarter-average price
   weighted by 13F share changes over time), clearly labeled as an estimate
   in the UI, matching industry practice.
