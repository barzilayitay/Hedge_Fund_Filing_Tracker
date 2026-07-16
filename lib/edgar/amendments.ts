import type { Sql } from "../db/sql";

/**
 * Amendment semantics for 13F-HR/A filings (ARCHITECTURE.md decision 3).
 *
 * - RESTATEMENT: the /A replaces what was on file for that period, so the
 *   filings it restates are marked is_superseded and drop out of
 *   filings_effective. The /A becomes the effective filing.
 * - NEW HOLDINGS: the /A adds holdings that were previously confidential.
 *   Both it and the original stay effective and their rows are unioned.
 *
 * A 13F-HR/A never names the filing it amends — the cover page only repeats
 * the period — so the target is resolved from (cik, period_of_report).
 *
 * Reconciliation is written as "recompute the whole period from scratch"
 * rather than "apply this one filing" so that it does not depend on the order
 * filings are ingested: an /A that arrives before its original still ends up
 * correct once the original lands and the period is reconciled again.
 */

interface PeriodFiling {
  accession_no: string;
  form_type: string;
  filed_at: string;
  amendment_type: string | null;
  is_superseded: boolean;
  amends_accession_no: string | null;
}

export interface ReconcileResult {
  /** Accessions now excluded from filings_effective. */
  superseded: string[];
  /** Accessions that are effective for this period. */
  effective: string[];
  warnings: string[];
}

/** Filed-date order, with the accession as a stable tie-break. */
function byFiling(a: PeriodFiling, b: PeriodFiling): number {
  return (
    a.filed_at.localeCompare(b.filed_at) ||
    a.accession_no.localeCompare(b.accession_no)
  );
}

function isAmendment(f: PeriodFiling): boolean {
  return f.form_type.endsWith("/A");
}

/**
 * Recompute `amends_accession_no` and `is_superseded` for every filing a filer
 * made for one period. Safe to run repeatedly.
 */
export async function reconcilePeriod(
  sql: Sql,
  cik: string,
  periodOfReport: string,
): Promise<ReconcileResult> {
  const filings = (
    await sql.query<PeriodFiling>(
      `select accession_no, form_type, filed_at::text as filed_at,
              amendment_type, is_superseded, amends_accession_no
         from filings
        where cik = $1 and period_of_report = $2 and form_type like '13F-HR%'`,
      [cik, periodOfReport],
    )
  ).sort(byFiling);

  const warnings: string[] = [];
  if (filings.length === 0) {
    return { superseded: [], effective: [], warnings };
  }

  // The original is the earliest non-amendment filing for the period.
  const original = filings.find((f) => !isAmendment(f)) ?? null;
  if (!original) {
    warnings.push(
      `${cik} period ${periodOfReport}: amendment(s) on file with no original ingested yet`,
    );
  }

  // A RESTATEMENT replaces everything filed up to and including its own filing
  // date. Anything filed after it (e.g. a later NEW HOLDINGS /A) still applies.
  const restatements = filings.filter(
    (f) => isAmendment(f) && f.amendment_type === "RESTATEMENT",
  );
  const latestRestatement =
    restatements.length > 0 ? restatements[restatements.length - 1] : null;

  const superseded: string[] = [];
  const effective: string[] = [];

  for (const f of filings) {
    const shouldSupersede =
      latestRestatement !== null &&
      f.accession_no !== latestRestatement.accession_no &&
      byFiling(f, latestRestatement) < 0;

    (shouldSupersede ? superseded : effective).push(f.accession_no);

    // An /A points at the original it amends; originals point at nothing.
    const amends =
      isAmendment(f) && original !== null ? original.accession_no : null;

    if (f.is_superseded !== shouldSupersede || f.amends_accession_no !== amends) {
      await sql.query(
        `update filings
            set is_superseded = $2, amends_accession_no = $3
          where accession_no = $1`,
        [f.accession_no, shouldSupersede, amends],
      );
    }
  }

  return { superseded, effective, warnings };
}
