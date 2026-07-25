import type { Sql } from "@/lib/db/sql";
import { loadForm4 } from "@/lib/edgar/loadForm4";
import { seedPhase2 } from "./phase2";
import { parseForm4Fixture } from "./form4";

/**
 * Seed the state the Phase 4 API tests run against:
 *   - Phase 2 analytics (two Berkshire 13F quarters + prices + companies +
 *     securities + refreshed matview) via seedPhase2, so the fund/stock
 *     holdings RPCs have data and AAPL is a mapped, Berkshire-held ticker.
 *   - All eight Apple Form 4 fixtures, so the stock-insider and confluence RPCs
 *     for AAPL (issuer CIK 0000320193) have transactions.
 *   - Pershing Square Capital Management as a 13F filer plus its joint Form 4
 *     (psh-entity), so the fund-realtime RPC has a 10%-owner-fund feed.
 *
 * Everything loads through the same loaders production uses; no fixture is
 * re-fetched.
 */

/** Berkshire Hathaway 13F filer CIK (10-digit), created by seedPhase2. */
export const BRK_CIK = "0001067983";
/** Quarters loaded by seedPhase2. */
export const BRK_PRIOR_QUARTER = "2025-12-31";
export const BRK_CURRENT_QUARTER = "2026-03-31";

export const PERSHING_CIK = "0001336528";
export const PERSHING_SLUG = "pershing-square";

const APPLE_FIXTURES = [
  "aapl-insider-1-2026-06-17",
  "aapl-insider-2-2026-06-17",
  "aapl-insider-3-2026-05-29",
  "aapl-insider-4-2026-05-12",
  "aapl-insider-5-2026-05-08",
  "aapl-insider-6-2026-04-27",
  "aapl-insider-7-2026-04-17",
  "aapl-insider-8-2026-04-17",
];

export async function seedPhase4(sql: Sql): Promise<void> {
  await seedPhase2(sql);

  for (const label of APPLE_FIXTURES) {
    await loadForm4(sql, parseForm4Fixture(label));
  }

  // Pershing Square as a 13F filer with a known slug, then its joint Form 4 —
  // the reporting owner CIK matches this filer, so it surfaces in
  // fund_realtime_activity.
  await sql.query(
    `insert into filers (cik, name, slug)
     values ($1, 'Pershing Square Capital Management, L.P.', $2)
     on conflict (cik) do update set slug = excluded.slug`,
    [PERSHING_CIK, PERSHING_SLUG],
  );
  await loadForm4(sql, parseForm4Fixture("psh-entity-2026-06-08"));
}

/** The slug seedPhase2 assigned to the Berkshire filer (slugify of its name). */
export async function berkshireSlug(sql: Sql): Promise<string> {
  const [row] = await sql.query<{ slug: string }>(
    `select slug from filers where cik = $1`,
    [BRK_CIK],
  );
  return row.slug;
}
