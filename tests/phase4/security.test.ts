import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { seedPhase4, berkshireSlug, BRK_CURRENT_QUARTER } from "../helpers/phase4";
import { getFundHoldings } from "@/lib/api";

/**
 * Security-surface regression tests.
 *
 * The Phase 4 gate review found two ways the anon surface had silently leaked
 * open, both invisible to the original denial-only test ("is holdings_13f
 * denied?"). A denial test cannot see EXTRA surface. These tests instead
 * ENUMERATE the whole surface from the catalog and assert it equals a committed
 * expected set, so any new anon-reachable function or relation fails the build.
 *
 *   - GRANT-SURFACE SNAPSHOT: exactly six functions are anon-executable, and no
 *     relation is reachable by anon, authenticated or PUBLIC under any
 *     privilege. This catches a PUBLIC-executable helper like refresh_derived()
 *     — Postgres grants EXECUTE to PUBLIC on every new function by default, so
 *     that leak reproduces on PGlite and is caught here in CI. (The
 *     Supabase-only pg_default_acl leak does NOT reproduce on PGlite; that one
 *     needs the Docker-gated migration job — see specs/phase-4-api.md.)
 *
 *     `authenticated` and sequences are included in the relation sweep after
 *     gate review #2, which found authenticated still holding D/x/t/m — TRUNCATE
 *     plus MAINTAIN, i.e. REFRESH MATERIALIZED VIEW — on all 17 relations on
 *     real Supabase, the same privilege set as BLOCKER-2 one role over.
 *   - INVARIANTS: every base table has RLS enabled; every security-definer
 *     function has a pinned search_path. Both are driven from the catalog, not a
 *     hardcoded list, so a table/function added later is covered automatically.
 *
 * NOTE: never delete these as "redundant". BLOCKER-1 began as an inert Phase 2
 * grant (refresh_derived, PUBLIC-executable) that only became reachable when
 * Phase 4 created the anon role — the guard necessarily spans phases.
 */

/** The complete intended anon EXECUTE surface: exactly these six RPCs. */
const EXPECTED_ANON_FUNCTIONS = [
  "get_confluence",
  "get_fund_holdings",
  "get_fund_realtime",
  "get_fund_summary",
  "get_stock_insiders",
  "get_stock_institutional",
].sort();

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe("anon grant-surface snapshot", () => {
  it("anon can EXECUTE exactly the six RPCs and no other function", async () => {
    const rows = await db.query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('anon', p.oid, 'EXECUTE')
        order by p.proname`,
    );
    // If this fails with an extra name (e.g. refresh_derived, set_updated_at),
    // a helper function has leaked onto the anon surface — see BLOCKER-1.
    expect(rows.map((r) => r.proname)).toEqual(EXPECTED_ANON_FUNCTIONS);
  });

  it("no PostgREST role holds any privilege on any relation in public", async () => {
    // aclexplode over relacl surfaces every grant of every privilege type
    // (SELECT..TRIGGER and MAINTAIN alike) to anon, authenticated (regrole) or
    // PUBLIC (grantee 0). Expected: empty. This is what would have caught the
    // removed direct view grants (BLOCKER-3) and, on real Supabase, the
    // MAINTAIN leak on anon (gate #1) and on authenticated (gate #2).
    //
    // relkind covers r (table), v (view), m (matview) and S (sequence). No
    // sequence exists in public today; it is swept so that a later identity or
    // serial column cannot quietly re-open the surface via the sequence default
    // ACL, which is a separate object class from tables.
    const rows = await db.query<{
      relkind: string;
      relname: string;
      grantee: string;
      privilege_type: string;
    }>(
      `select c.relkind, c.relname,
              case when pr.grantee = 0 then 'PUBLIC'
                   else pr.grantee::regrole::text end as grantee,
              pr.privilege_type
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(c.relacl) pr
        where n.nspname = 'public'
          and c.relkind in ('r', 'v', 'm', 'S')
          and pr.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)
        order by c.relname, grantee, pr.privilege_type`,
    );
    expect(rows).toEqual([]);
  });
});

describe("security invariants (catalog-driven)", () => {
  it("every base table in public has row level security enabled", async () => {
    const rows = await db.query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and not c.relrowsecurity
        order by c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("every security-definer function in public pins its search_path", async () => {
    const rows = await db.query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosecdef
          and not exists (
            select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
             where cfg like 'search_path=%'
          )
        order by p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  it("the six RPCs are all security-definer with a pinned search_path", async () => {
    const rows = await db.query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosecdef
          and exists (
            select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
             where cfg like 'search_path=%'
          )
        order by p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(EXPECTED_ANON_FUNCTIONS);
  });
});

describe("anon behavioral denial (SET ROLE anon)", () => {
  const BASE_TABLES = [
    "holdings_13f",
    "filings",
    "form4_transactions",
    "filers",
    "securities",
    "companies",
    "insiders",
    "insider_relationships",
    "ownership_13dg",
    "quarterly_prices",
  ];
  // Views that must NOT be directly readable by anon (data reaches anon only via
  // the RPCs). Includes the five formerly-granted views plus the two internal
  // views that were never intended to be exposed.
  const DENIED_VIEWS = [
    "fund_holdings_enriched",
    "fund_quarter_summary",
    "fund_realtime_activity",
    "insider_cluster_buys",
    "insider_sentiment",
    "filings_effective",
    "holdings_13f_agg",
  ];

  let brkSlug: string;
  beforeEach(async () => {
    await db.reset();
    await seedPhase4(db.sql); // seeded as the owner, before dropping to anon
    brkSlug = await berkshireSlug(db.sql);
  });

  it("anon reaches data via the RPC but cannot read any base table or view", async () => {
    await db.query("set role anon");
    try {
      // The security-definer RPC still works for anon.
      const res = await getFundHoldings(db.sql, {
        fundSlug: brkSlug,
        quarter: BRK_CURRENT_QUARTER,
      });
      expect(res.total_count).toBeGreaterThan(0);

      // Every base table read is denied.
      for (const table of BASE_TABLES) {
        await expect(
          db.query(`select * from ${table} limit 1`),
        ).rejects.toThrow(/permission denied/i);
      }
      // Every derived view read is denied too — no direct-view bypass exists.
      for (const view of DENIED_VIEWS) {
        await expect(
          db.query(`select * from ${view} limit 1`),
        ).rejects.toThrow(/permission denied/i);
      }
    } finally {
      await db.query("reset role");
    }
  });

  it("anon cannot execute the un-granted helper functions", async () => {
    await db.query("set role anon");
    try {
      await expect(db.query(`select refresh_derived()`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await db.query("reset role");
    }
  });

  // Gate review #2: `authenticated` retained the same D/x/t/m the default ACL
  // hands out — TRUNCATE (which RLS does NOT gate) and MAINTAIN (REFRESH
  // MATERIALIZED VIEW), i.e. BLOCKER-2's primitive one role over. PGlite has no
  // Supabase default ACL, so this test cannot reproduce the leak; it pins the
  // intended behaviour and the catalog sweep above plus the Docker-gated job
  // (scripts/ci/assert-anon-surface.sql) are what detect it on real Supabase.
  it("authenticated cannot read, TRUNCATE or REFRESH anything", async () => {
    await db.query("set role authenticated");
    try {
      await expect(db.query(`select * from holdings_13f limit 1`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(db.query(`truncate holdings_13f`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        db.query(`refresh materialized view fund_holdings_enriched`),
      ).rejects.toThrow(/permission denied|must be owner/i);
      await expect(db.query(`select refresh_derived()`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await db.query("reset role");
    }
  });
});
