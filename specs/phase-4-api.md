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

## Gate review #1 — FAILED, then remediated (security surface)

The first Phase 4 gate review (adversarial, live psql + PostgREST against a
`db reset` database) **failed the phase on the security model**. The stated
model was "anon reaches six RPCs + five views"; the *deployed* model additionally
exposed an executable helper and write privileges on views. Two blockers, both
now fixed on this branch:

- **BLOCKER-1 — `refresh_derived()` executable by anon over PostgREST.** Postgres
  grants `EXECUTE` to `PUBLIC` on every new function by default. `refresh_derived()`
  (created in Phase 2) was therefore PUBLIC-executable and became **anon-reachable
  the moment Phase 4 created the `anon` role** — an inert cross-phase grant turned
  into a live primitive. Verified `POST /rest/v1/rpc/refresh_derived` → `HTTP 204`
  with only the anon key. It runs `REFRESH MATERIALIZED VIEW` (non-CONCURRENTLY →
  AccessExclusiveLock), so an unauthenticated client could block every read path.
  **Fix:** the API migration now `revoke execute on all functions in schema public
  from public`, explicitly revokes `refresh_derived()`/`set_updated_at()` from
  public+anon, `alter default privileges … revoke execute on functions`, then
  grants EXECUTE back on only the six RPCs.

- **BLOCKER-2 — anon held `TRUNCATE`/`TRIGGER`/`REFERENCES`/`MAINTAIN` on all
  seven views/matviews.** Supabase ships a `pg_default_acl` that auto-grants
  `D/x/t/m` to anon on every relation the migration role creates in `public`.
  The original revoke loop named only base tables (relkind `r`), so the views
  kept the default grant. `MAINTAIN` (PG17+) alone lets a role `REFRESH` a
  matview — confirmed working as anon — a second, independent path to BLOCKER-1's
  DoS. **Fix:** `revoke all on all tables in schema public from anon, public`
  ("all tables" covers relkind r, v, m) plus `alter default privileges … revoke
  all on tables` so future relations are not re-granted.

- **BLOCKER-3 — the five direct view grants removed entirely.** They were unused
  (`lib/api.ts` reads only the six RPCs) and voided the RPC's sort whitelist,
  500-row cap and slug-scoping, and enabled enumeration. A future phase that
  needs a direct view will grant it deliberately, with a row cap.

- **Testing strategy — PGlite ratified, but ONLY alongside the grant-surface
  snapshot test (supersedes open question 2).** Running the acceptance tests on
  PGlite (not a live "local Supabase") is confirmed as the standing strategy,
  consistent with CLAUDE.md's "the test suite needs no Docker". **But it is valid
  only because the security surface is now asserted positively, not by denial.**
  A denial-only test ("is `holdings_13f` denied?") **cannot see extra surface** —
  that is exactly why both blockers shipped. `tests/phase4/security.test.ts` now
  ENUMERATES from the catalog and asserts the anon surface *equals* a committed
  set (exactly six executable functions; zero anon-reachable relations), plus
  invariants (every base table has RLS; every `security definer` function pins
  `search_path`), all catalog-driven so a new object is covered automatically.
  BLOCKER-1's PUBLIC-execute default reproduces on PGlite and is now caught in CI.
  **This snapshot test spans phases by design (BLOCKER-1 originated in Phase 2)
  and must never be deleted as redundant.** BLOCKER-2's Supabase-specific
  `pg_default_acl` does NOT reproduce on PGlite; covering it needs a Docker-gated
  migration job (proposed separately, not yet built).

- **Smaller fixes from the review.** CSV/TSV export now neutralizes
  spreadsheet-formula-prefixed cells (`= + - @ \t \r` → leading `'`) since the
  issuer Name is filer-controlled 13F free text; `get_fund_holdings` caps `page`
  and uses a `bigint` offset so an anon-controlled page cannot raise SQLSTATE
  22003; the export route validates `fund` against the slug regex (as `quarter`/
  `format` already were); the `top_new_buys`/`top_sells` zod schemas are tightened
  from `record(unknown)` to the SQL's fixed object shape; `scripts/seed-dev.ts`
  refuses a non-localhost `DATABASE_URL` unless `--i-know-what-im-doing` is passed
  (and `npm run seed` is on the guard-bash blocklist).

- **Export buffers in memory (not streamed) — Phase 6 hardening.** `route.ts`
  builds the full body via `buildHoldingsExport` (paging the RPC) and returns it
  in one `Response`; there is no auth or rate limiting yet. Fine for 13F-sized
  sets; unbounded-size streaming + rate limiting are tagged for Phase 6.
