# Phase 4 — API layer

## Objective
A stable, typed read API over the derived data: RPC functions for heavy
queries, PostgREST for simple reads, one export route.

## Prerequisites
Phases 1–3 complete.

## Deliverables
1. **RPC functions** (migrations, `security definer`, read-only):
   - `get_fund_holdings(fund_slug, quarter, sort_col, sort_dir, page, page_size, search)`
     → enriched holdings rows + total_count. Sorting/pagination server-side;
     whitelist sort_col against known columns (no SQL injection via sort).
   - `get_fund_summary(fund_slug, quarter)` → fund_quarter_summary row +
     available quarters list.
   - `get_fund_realtime(fund_slug, limit)` → Form 4 feed for 10%-owner funds.
   - `get_stock_institutional(ticker, quarter, page, page_size)` → funds
     holding the stock, with position changes.
   - `get_stock_insiders(ticker, page, page_size, codes[])` → Form 4 table
     rows + sentiment summary + active cluster flag.
   - `get_confluence(ticker, from_quarter)` → per-quarter net institutional
     share change + individual insider transactions, shaped for charting.
2. **Typed client** `lib/api.ts`: one function per RPC, zod-parsed responses,
   shared with server components.
3. **Export route** `app/api/export/route.ts?fund=&quarter=&format=csv|tsv`
   → streams the full holdings set with headers matching UI column names.
4. **Security**: RLS enabled on all tables; anon role gets SELECT via the RPC
   functions and specific views only; no direct table reads for anon.
5. **Seed script** `scripts/seed-dev.ts`: loads all fixtures so the app runs
   locally with realistic data (`npm run seed`).

## Acceptance criteria (tests in `tests/phase4/`, run against local Supabase)
- Each RPC returns the documented shape (zod schemas as the contract).
- Pagination: page 2 with page_size 10 returns rows 11–20 of the sorted set.
- Sorting by market_value desc matches SQL ORDER BY ground truth.
- Invalid sort_col rejected with a clean error, not a 500.
- Export CSV row count = holdings count + header; opens as valid CSV
  (parse it back in the test).
- Anon key cannot SELECT directly from `holdings_13f` (RLS proven by test).
- `typecheck`, `lint`, full `test` clean.

## Out of scope
Auth/user accounts, watchlists, alerts, rate limiting (later), UI.

## As-built notes (Phase 4 implementation)

These reflect the shipped implementation and accepted deviations. See
`PROGRESS.md` "Decisions → Phase 4" for the full rationale on each.

- **RPCs return a single `jsonb` value.** Each of the six functions returns one
  jsonb object (e.g. `{ fund, quarter, total_count, rows }`) rather than a
  `setof`. This lets one call carry both `rows` and `total_count`/summary, makes
  the wire shape an explicit zod contract (`lib/api.ts`), and is stable against
  later column additions. jsonb renders numeric as JSON number and date as an
  ISO string, which the zod schemas expect.

- **`lib/api.ts` talks to the DB via the `Sql` port, not `@supabase/supabase-js`.**
  Confirmed with the human before coding. This matches the whole repo (Phase 1
  Decision 6) and makes every RPC unit-testable on PGlite. A supabase-js adapter
  is a Phase 5 concern (the browser/server-component transport); the zod
  contracts are transport-independent. `@supabase/supabase-js` was NOT re-added.

- **Acceptance tests run on PGlite, not a live "local Supabase".** The spec's
  criteria header says "run against local Supabase", but CLAUDE.md's binding
  rule is "the test suite needs no Docker", and every prior phase runs the real
  migrations against embedded Postgres (PGlite). The Phase 4 tests do the same —
  including the anon-role RLS denial test (`SET ROLE anon` on the PGlite
  connection). `npx supabase db reset` is the real-Postgres check, run at the
  milestone: all five migrations apply cleanly and the anon security model was
  additionally verified on real Supabase Postgres (anon can EXECUTE the six
  RPCs, direct base-table SELECT is denied).

- **`anon` role is created conditionally in the migration.** Supabase
  pre-provisions `anon`; a bare Postgres/PGlite does not. The migration creates
  it `if not exists` so the same DDL runs in both places. RLS is enabled on
  every base table with no anon policy and privileges revoked, so anon cannot
  read a base table directly; the six `security definer` RPCs (owned by the
  migration role, which owns the tables) read on its behalf, and `select` is
  granted to anon on five derived views only (`fund_holdings_enriched`,
  `fund_quarter_summary`, `fund_realtime_activity`, `insider_cluster_buys`,
  `insider_sentiment`).

- **Sort injection safety.** `get_fund_holdings` builds its `ORDER BY` from a
  hard whitelist of sort columns and `{asc,desc}`; an unknown `sort_col` raises
  `invalid sort_col` (SQLSTATE 22023 → a clean rejected promise, not a 500).
  Every data value is passed with `EXECUTE ... USING`.

- **Export pages the RPC.** `app/api/export/route.ts` is a thin wrapper over
  `buildHoldingsExport` (`lib/export.ts`), which pages `get_fund_holdings`
  (500/page) to gather the full set and serialises it CSV/TSV with headers
  matching the UI column names. The core is unit-tested on PGlite (round-trip
  parse); the route itself is the production path and needs `pg` + `DATABASE_URL`.

- **`filings.cik → filers` trigger guard stays Phase 6.** Confirmed with the
  human. Phase 4's condition for pulling it forward was "if Phase 4 introduces
  the production Sql path"; it does not — the API is read-only RPCs and
  `scripts/prod-sql.ts` is unchanged (the `seed-dev` script merely reuses it
  locally). The guard remains a Phase 6 follow-up.

- **`scripts/prod-sql.ts` specifier hardening.** The `pg` dynamic-import
  specifier is now assembled at runtime (`["p","g"].join("")`) so neither tsc
  nor the Next/Turbopack bundler resolves the optional, uninstalled dependency
  when it traces the new export route. `npm run build` is warning-free.
