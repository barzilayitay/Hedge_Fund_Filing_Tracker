# Phase 1 — 13F ingestion

## Objective
Parse any 13F-HR/13F-HR/A filing into normalized tables, with correct
amendment semantics, value-unit normalization, and CUSIP→ticker mapping.

## Prerequisites
Phase 0 complete. Work only against fixtures; no live EDGAR calls in tests.

## Deliverables
1. **Migrations** creating: `filers`, `filings`, `securities`, `holdings_13f`,
   `companies` (columns per ARCHITECTURE.md), plus view `filings_effective`
   (excludes `is_superseded = true`).
2. **Parser** `lib/edgar/parse13f.ts`:
   - Input: cover-page XML + information-table XML strings.
   - Output (zod-validated): filer info, filing metadata (accession, period,
     filed_at, amendment_type if 13F-HR/A), holdings rows.
   - Normalizes `value` to whole USD using period_of_report (pre-2023 periods
     are reported in $ thousands — multiply by 1000).
   - Preserves putCall, share class, SH/PRN distinction; a fund can hold the
     same CUSIP in multiple rows (e.g., shares + calls) — never collapse them.
3. **Amendment logic** `lib/edgar/amendments.ts`:
   - RESTATEMENT: mark the amended filing's target `is_superseded = true`;
     the /A becomes the effective filing for that period.
   - NEW HOLDINGS: /A rows append to the original; both remain effective.
   - Detection: cover page `amendmentType`; if absent on an /A, default to
     RESTATEMENT (conservative — avoids double counting) and log a warning.
4. **CUSIP mapping** `lib/edgar/cusipMap.ts`:
   - Seed `securities` from SEC `company_tickers.json` fixture (commit a copy).
   - `resolveCusips(cusips[])`: check `securities` first; unknown CUSIPs go to
     OpenFIGI in batches of 100 (mocked in tests); persist results including
     failures as `mapping_status='unmapped'`.
5. **Loader** `lib/edgar/load13f.ts`: parser output → upserts (idempotent on
   accession_no). Running the same filing twice must produce identical DB state.
6. Fill in `fixtures/13f/*.expected.json` with hand-verifiable values:
   row count, total portfolio value, 5 spot-check holdings per filing
   (cusip, shares, value).

## Implementation notes / pitfalls
- Some filings embed the info table in the primary doc; others ship a separate
  XML. Detect by XML namespace, not filename.
- CUSIPs may arrive with dropped leading zeros or lowercase — normalize to
  9-char uppercase, recompute nothing (checksum validation optional, log-only).
- `sshPrnamtType = PRN` rows are principal amounts (convertible debt), not
  shares — store in `principal_amt`, leave `shares` null.

## Acceptance criteria (tests in `tests/phase1/`)
- Every 13F fixture parses; row counts and total values match `expected.json`
  exactly; spot-check holdings match.
- Pre-2023 fixture: total value equals expected whole-dollar figure (unit
  conversion proven).
- RESTATEMENT pair: after loading both, `filings_effective` contains only the
  /A; portfolio total equals the /A's expected total (no double counting).
- NEW HOLDINGS pair: effective holdings = original rows + /A rows.
- Idempotency: load Berkshire fixture twice → row counts unchanged, updated_at
  aside, table state identical.
- CUSIP mapping: known CUSIPs resolve from seed; unknown CUSIP ends as
  `unmapped` and its holding row still exists.
- `typecheck`, `lint`, full `test` clean.

## Out of scope
Prices, % of portfolio, diffs (Phase 2). Form 4 (Phase 3). Any UI or API.

## As-built notes (post-Phase-1 gate review)

The following clarifications reflect the shipped implementation. See
`PROGRESS.md` "Decisions" for the full rationale on each.

- **`holdings_13f` primary key is `(accession_no, row_index)`**, not
  `(accession_no, cusip, put_call, share_class)`. The original PK collapsed
  60% of fixture rows because 13F information tables legitimately contain
  multiple rows for the same security within one filing (one row per
  `otherManager` combination — Berkshire reports Apple as 12 rows in one
  filing). `row_index` is the row's position in the information table.
  **Row identity is load-bearing on the loader's replace-per-accession
  behavior** (`load13f.ts` upserts all rows for an accession in one statement
  and then deletes any rows left over from a prior parse). Row-level upserts
  against `holdings_13f` are prohibited in every downstream phase.
  See Phase 2's AMENDMENT section for the mandatory `holdings_13f_agg`
  aggregation view built on top of this table.

- **Seed sources for the reference tables:**
  - `companies` is seeded from `fixtures/reference/company_tickers.json`
    (SEC ticker map, CIK → ticker + name; contains no CUSIPs).
  - `securities` is seeded from the **SEC Official List of Section 13(f)
    Securities** (`fixtures/reference/13flist2026q1.txt`, pinned at 2026q1),
    joined to `company_tickers.json` on normalized issuer name.
    `company_tickers.json` cannot seed `securities` directly because it
    contains no CUSIPs and `securities` is keyed on CUSIP.

- **`parse13f` signature is `(coverXml, infoTableXml, ref)`** where
  `ref: { accessionNo, filedAt }` is EDGAR submission metadata supplied by
  the caller. Neither the accession number nor the filing date appears
  anywhere in the filing's XML documents — they live only in the SEC
  submissions feed (`data.sec.gov/submissions/CIK{10-digit}.json`), so the
  poller (or fixture manifest in tests) is the source of truth for them.
