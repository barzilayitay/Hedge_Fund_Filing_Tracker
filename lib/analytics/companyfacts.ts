/**
 * Pure helper for SEC shares-outstanding data.
 *
 * `companies` stores a single shares_outstanding value + as-of date per issuer
 * (ARCHITECTURE.md schema), so we reduce the SEC series to its most recent
 * reported figure. Used both by the one-time fixture builder and by
 * scripts/load-companyfacts.ts.
 *
 * Input is the SEC "company concept" response for
 * dei:EntityCommonStockSharesOutstanding, which has the same
 * `units.shares[]` shape as the corresponding slice of the full companyfacts
 * document, so the loader accepts either.
 */

export interface SharesOutstanding {
  value: number;
  /** ISO date the figure is reported as-of. */
  asof: string;
}

interface ConceptUnitEntry {
  end?: string;
  val?: number;
}

interface CompanyConceptLike {
  units?: { shares?: ConceptUnitEntry[] };
  // Full companyfacts nests the concept one level deeper.
  facts?: { dei?: { EntityCommonStockSharesOutstanding?: { units?: { shares?: ConceptUnitEntry[] } } } };
}

/**
 * Most recent EntityCommonStockSharesOutstanding value, by reported `end` date.
 * Returns null if the document carries no usable figure.
 */
export function pickSharesOutstanding(doc: unknown): SharesOutstanding | null {
  const d = doc as CompanyConceptLike;
  const entries =
    d.units?.shares ??
    d.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares ??
    [];

  let best: SharesOutstanding | null = null;
  for (const e of entries) {
    if (typeof e.val !== "number" || typeof e.end !== "string") continue;
    if (best === null || e.end > best.asof) {
      best = { value: e.val, asof: e.end };
    }
  }
  return best;
}
