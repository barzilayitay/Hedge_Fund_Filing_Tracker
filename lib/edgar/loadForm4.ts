import type { Sql } from "../db/sql";
import type { ParsedForm4 } from "./schemasForm4";

/**
 * Parsed Form 4 -> database rows.
 *
 * Replace-per-accession, mirroring load13f (Phase 1): upsert every
 * (accession, owner, table_type, row_index) row for the filing, then delete
 * leftovers from a prior parse. Re-ingesting a filing is a no-op beyond
 * updated_at (hard rule 6). No row-level upserts against a raw filing-row table
 * beyond this keyed replace.
 *
 * The shared `filings` table holds a row per Form 4 (form_type '4'/'4/A'),
 * grouped under the issuer CIK. Form 4/A amendment supersession is NOT yet
 * implemented (no fixture exercises it; deferred, see PROGRESS.md); the row
 * still lands so a later phase can reconcile it.
 */

export interface LoadForm4Result {
  accessionNo: string;
  issuerCik: string;
  ownerCiks: string[];
  transactionsLoaded: number;
  holdingsSkipped: number;
  warnings: string[];
}

async function upsertIssuerAsFiling(
  sql: Sql,
  parsed: ParsedForm4,
): Promise<void> {
  const f = parsed.filing;
  // filings.cik is the issuer for a Form 4. is_superseded / amends_accession_no
  // are left at their defaults (Form 4/A reconciliation is deferred).
  await sql.query(
    `insert into filings (accession_no, cik, form_type, period_of_report, filed_at)
     values ($1, $2, $3, $4, $5)
     on conflict (accession_no) do update
       set cik = excluded.cik,
           form_type = excluded.form_type,
           period_of_report = excluded.period_of_report,
           filed_at = excluded.filed_at`,
    [f.accessionNo, f.issuerCik, f.formType, f.periodOfReport, f.filedAt],
  );
}

async function upsertInsiders(sql: Sql, parsed: ParsedForm4): Promise<void> {
  for (const owner of parsed.owners) {
    await sql.query(
      `insert into insiders (cik, name) values ($1, $2)
       on conflict (cik) do update set name = excluded.name`,
      [owner.cik, owner.name],
    );
    await sql.query(
      `insert into insider_relationships (
         insider_cik, company_cik, is_officer, is_director, is_ten_pct,
         is_other, officer_title, other_text
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (insider_cik, company_cik) do update
         set is_officer = excluded.is_officer,
             is_director = excluded.is_director,
             is_ten_pct = excluded.is_ten_pct,
             is_other = excluded.is_other,
             officer_title = excluded.officer_title,
             other_text = excluded.other_text`,
      [
        owner.cik,
        parsed.issuer.cik,
        owner.isOfficer,
        owner.isDirector,
        owner.isTenPct,
        owner.isOther,
        owner.officerTitle,
        owner.otherText,
      ],
    );
  }
}

async function upsertTransactions(
  sql: Sql,
  parsed: ParsedForm4,
): Promise<void> {
  const rows = parsed.transactions;
  const accessionNo = parsed.filing.accessionNo;

  if (rows.length > 0) {
    await sql.query(
      `insert into form4_transactions (
         accession_no, insider_cik, company_cik, table_type, row_index,
         security_title, transaction_code, transaction_date, shares, price,
         acquired_disposed, shares_owned_after, direct_indirect,
         nature_of_ownership, is_10b5_1, conversion_or_exercise_price,
         exercise_date, expiration_date, underlying_security_title,
         underlying_shares, footnotes
       )
       select $1, * from unnest(
         $2::text[], $3::text[], $4::text[], $5::int[],
         $6::text[], $7::text[], $8::date[], $9::numeric[], $10::numeric[],
         $11::text[], $12::numeric[], $13::text[],
         $14::text[], $15::boolean[], $16::numeric[],
         $17::date[], $18::date[], $19::text[],
         $20::numeric[], $21::jsonb[]
       )
       on conflict (accession_no, insider_cik, table_type, row_index) do update
         set company_cik = excluded.company_cik,
             security_title = excluded.security_title,
             transaction_code = excluded.transaction_code,
             transaction_date = excluded.transaction_date,
             shares = excluded.shares,
             price = excluded.price,
             acquired_disposed = excluded.acquired_disposed,
             shares_owned_after = excluded.shares_owned_after,
             direct_indirect = excluded.direct_indirect,
             nature_of_ownership = excluded.nature_of_ownership,
             is_10b5_1 = excluded.is_10b5_1,
             conversion_or_exercise_price = excluded.conversion_or_exercise_price,
             exercise_date = excluded.exercise_date,
             expiration_date = excluded.expiration_date,
             underlying_security_title = excluded.underlying_security_title,
             underlying_shares = excluded.underlying_shares,
             footnotes = excluded.footnotes`,
      [
        accessionNo,
        rows.map((r) => r.ownerCik),
        rows.map(() => parsed.issuer.cik),
        rows.map((r) => r.tableType),
        rows.map((r) => r.rowIndex),
        rows.map((r) => r.securityTitle),
        rows.map((r) => r.transactionCode),
        rows.map((r) => r.transactionDate),
        rows.map((r) => r.shares),
        rows.map((r) => r.price),
        rows.map((r) => r.acquiredDisposed),
        rows.map((r) => r.sharesOwnedAfter),
        rows.map((r) => r.directIndirect),
        rows.map((r) => r.natureOfOwnership),
        rows.map((r) => r.is10b5One),
        rows.map((r) => r.conversionOrExercisePrice),
        rows.map((r) => r.exerciseDate),
        rows.map((r) => r.expirationDate),
        rows.map((r) => r.underlyingSecurityTitle),
        rows.map((r) => r.underlyingShares),
        rows.map((r) => JSON.stringify(r.footnotes)),
      ],
    );
  }

  // Drop rows left behind if this accession previously parsed to more rows for
  // some (owner, table_type). Anything whose (owner, table_type, row_index) is
  // not in the freshly-loaded set is removed.
  await sql.query(
    `delete from form4_transactions ft
      where ft.accession_no = $1
        and not exists (
          select 1
            from unnest($2::text[], $3::text[], $4::int[]) as k(owner, tt, ri)
           where k.owner = ft.insider_cik
             and k.tt = ft.table_type
             and k.ri = ft.row_index
        )`,
    [
      accessionNo,
      rows.map((r) => r.ownerCik),
      rows.map((r) => r.tableType),
      rows.map((r) => r.rowIndex),
    ],
  );
}

/** Ingest one parsed Form 4. Safe to call repeatedly with the same input. */
export async function loadForm4(
  sql: Sql,
  parsed: ParsedForm4,
): Promise<LoadForm4Result> {
  const warnings = [...parsed.warnings];

  return sql.transaction(async (tx) => {
    await upsertIssuerAsFiling(tx, parsed);
    await upsertInsiders(tx, parsed);
    await upsertTransactions(tx, parsed);

    return {
      accessionNo: parsed.filing.accessionNo,
      issuerCik: parsed.filing.issuerCik,
      ownerCiks: parsed.owners.map((o) => o.cik),
      transactionsLoaded: parsed.transactions.length,
      holdingsSkipped: parsed.stats.holdingsSkipped,
      warnings,
    };
  });
}
