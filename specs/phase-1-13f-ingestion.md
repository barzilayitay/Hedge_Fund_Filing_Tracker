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
