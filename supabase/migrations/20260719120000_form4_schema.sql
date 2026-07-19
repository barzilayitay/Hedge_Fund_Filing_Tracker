-- Phase 3: Form 4 insider-transaction ingestion + derived signal views.
--
-- Tables per ARCHITECTURE.md: insiders, insider_relationships,
-- form4_transactions (footnotes as jsonb keyed by footnote id), plus the
-- derived views insider_cluster_buys, insider_sentiment and
-- fund_realtime_activity. A stub ownership_13dg table is created for the
-- 13D/G feed a later phase fills in (Phase 3 spec: "stub the table, fill
-- later").
--
-- SHARED filings TABLE (binding, from both prior gate reviews): `filings`
-- holds one row per SEC filing across BOTH 13F and Form 4. Two consequences
-- are handled here:
--   1. filings.cik referenced filers(cik) — a 13F-only universe. A Form 4's
--      grouping CIK is its *issuer* (e.g. Apple), which is not a 13F filer, so
--      that foreign key is dropped below. filings.cik now means "the CIK the
--      filing is grouped under": the 13F manager for 13F filings, the issuer
--      for Form 4. The loader still inserts the filer/issuer row first, so the
--      relationship is maintained in practice; only the DB-level FK (which
--      cannot span two disjoint CIK universes) is removed.
--   2. Every 13F-only query path must filter by form_type now that Form 4 rows
--      share the table. Audited: holdings_13f_agg already filters
--      form_type like '13F-HR%'; reconcilePeriod (lib/edgar/amendments.ts)
--      already filters form_type like '13F-HR%'; filings_effective is a plain
--      pass-through and its 13F consumers all filter. The Form 4 views below
--      read form4_transactions (never filings/holdings), so they cannot pick
--      up 13F rows.

-- ---------------------------------------------------------------------------
-- Relax the 13F-only foreign key on the shared filings table (see header).
-- ---------------------------------------------------------------------------
alter table filings drop constraint filings_cik_fkey;

comment on column filings.cik is
  'CIK the filing is grouped under: the 13F manager for 13F filings, the '
  'issuer for Form 4. Not FK-constrained because 13F managers and Form 4 '
  'issuers are disjoint CIK universes (Phase 3).';

-- The amendment-type invariant was written for 13F only: amendment_type holds
-- the 13F enum (RESTATEMENT / NEW HOLDINGS), which a Form 4/A does not carry.
-- Re-scope it so it constrains 13F filings exactly as before, and requires
-- every non-13F filing (Form 4, Form 4/A) to leave amendment_type null. Form
-- 4/A supersession is tracked by a later phase (deferred; see PROGRESS.md).
alter table filings drop constraint filings_amendment_type_only_on_amendment;
alter table filings add constraint filings_amendment_type_only_on_amendment check (
  case
    when form_type like '13F-HR%'
      then (form_type like '%/A') = (amendment_type is not null)
    else amendment_type is null
  end
);

-- ---------------------------------------------------------------------------
-- insiders — Form 4 reporting owners (people and entities).
-- ARCHITECTURE.md: insiders(cik, name). Entity owners (funds, holdcos) carry
-- rptOwnerName with no individual name parts; both are stored the same way.
-- ---------------------------------------------------------------------------
create table insiders (
  cik         text primary key,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger insiders_updated_at before update on insiders
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- insider_relationships — how an insider relates to a company, as reported on
-- the reportingOwnerRelationship block. One row per (insider, company); the
-- most recent Form 4 wins on re-ingest.
-- ---------------------------------------------------------------------------
create table insider_relationships (
  insider_cik   text not null references insiders (cik),
  company_cik   text not null,
  is_officer    boolean not null default false,
  is_director   boolean not null default false,
  is_ten_pct    boolean not null default false,
  is_other      boolean not null default false,
  officer_title text,
  other_text    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (insider_cik, company_cik)
);

create index insider_relationships_company_idx
  on insider_relationships (company_cik);

create trigger insider_relationships_updated_at before update
  on insider_relationships
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- form4_transactions — one row per (reporting owner, transaction). Joint
-- filings (multiple reportingOwner blocks) fan out to one row per owner per
-- transaction (Phase 3 spec).
--
-- PK note (deviates from ARCHITECTURE's "id PK"): the natural key
-- (accession_no, insider_cik, table_type, row_index) is the loader's
-- idempotency key. Using it as the PK makes replace-per-accession trivially
-- idempotent (upsert on conflict, then delete leftovers — the holdings_13f
-- pattern) without a surrogate id whose value would churn across re-ingest.
-- row_index is the transaction's position within its table_type in the
-- document, shared across a joint filing's owners.
--
-- Null vs 0 discipline (spec pitfalls): price is null for gifts/awards that
-- omit it and 0 for a genuine $0 award — never coerce one to the other.
-- Amounts carrying a footnote reference instead of a value are stored null
-- with the footnote retained.
-- ---------------------------------------------------------------------------
create table form4_transactions (
  accession_no        text not null references filings (accession_no) on delete cascade,
  insider_cik         text not null references insiders (cik),
  company_cik         text not null,
  table_type          text not null check (table_type in ('nonderiv', 'deriv')),
  row_index           integer not null,

  security_title      text,
  transaction_code    text,
  transaction_date    date,
  shares              numeric,
  price               numeric,
  acquired_disposed   text check (acquired_disposed in ('A', 'D')),
  shares_owned_after  numeric,
  direct_indirect     text check (direct_indirect in ('D', 'I')),
  nature_of_ownership text,
  is_10b5_1           boolean not null default false,

  -- Derivative-only fields (null on non-derivative rows).
  conversion_or_exercise_price numeric,
  exercise_date                date,
  expiration_date              date,
  underlying_security_title    text,
  underlying_shares            numeric,

  -- Footnotes referenced by this row, resolved id -> text.
  footnotes           jsonb not null default '{}'::jsonb,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  primary key (accession_no, insider_cik, table_type, row_index)
);

create index form4_transactions_company_idx
  on form4_transactions (company_cik);
create index form4_transactions_insider_idx
  on form4_transactions (insider_cik);
create index form4_transactions_code_date_idx
  on form4_transactions (transaction_code, transaction_date);

create trigger form4_transactions_updated_at before update
  on form4_transactions
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- ownership_13dg — STUB for the 13D/G feed (Schedule 13D/13G beneficial
-- ownership). Phase 3 parses Form 4 only; ARCHITECTURE's fund_realtime_activity
-- overlays "Form 4 + 13D/G". This table is created empty so a later phase can
-- fill it and extend fund_realtime_activity without another base-table
-- migration. Columns are intentionally minimal and may change when filled.
-- ---------------------------------------------------------------------------
create table ownership_13dg (
  accession_no   text primary key references filings (accession_no) on delete cascade,
  owner_cik      text not null,
  company_cik    text not null,
  percent_owned  numeric,
  event_date     date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table ownership_13dg is
  'STUB (Phase 3): 13D/G beneficial-ownership rows, filled by a later phase.';

-- ---------------------------------------------------------------------------
-- insider_cluster_buys — companies where >= 3 distinct insiders made
-- open-market purchases (code P) within a rolling 30-day window.
--
-- Each code-P transaction date anchors a [start, start+30) window; a company
-- is a cluster for that window if >= 3 distinct insider CIKs bought in it.
-- Overlapping windows are expected (one candidate per anchor date). Value is
-- the summed P transaction value (shares * price; missing price contributes 0)
-- within the window.
-- ---------------------------------------------------------------------------
create view insider_cluster_buys as
with p as (
  select company_cik, insider_cik, transaction_date,
         coalesce(shares, 0) * coalesce(price, 0) as value
  from form4_transactions
  where transaction_code = 'P' and transaction_date is not null
)
select
  a.company_cik,
  a.transaction_date                       as window_start,
  (a.transaction_date + 30)                as window_end,
  count(distinct b.insider_cik)            as insider_count,
  sum(b.value)                             as total_value
from p a
join p b
  on b.company_cik = a.company_cik
 and b.transaction_date >= a.transaction_date
 and b.transaction_date <  a.transaction_date + 30
group by a.company_cik, a.transaction_date
having count(distinct b.insider_cik) >= 3;

-- ---------------------------------------------------------------------------
-- insider_sentiment — per company, trailing-90-day open-market (P/S only)
-- activity. "Trailing" is measured from the company's most recent transaction
-- in the data (as_of), so the view is deterministic over fixtures rather than
-- depending on wall-clock now().
--
-- Rule-10b5-1 sales are excluded from the bearish sell_count and from
-- net_value, and reported separately (planned_sell_count / planned_sell_value)
-- per the spec.
-- ---------------------------------------------------------------------------
create view insider_sentiment as
with tx as (
  select company_cik, insider_cik, transaction_date, transaction_code,
         is_10b5_1,
         coalesce(shares, 0) * coalesce(price, 0) as value
  from form4_transactions
  where transaction_code in ('P', 'S') and transaction_date is not null
),
ref as (
  select company_cik, max(transaction_date) as as_of
  from tx group by company_cik
),
win as (
  select tx.*, ref.as_of
  from tx join ref on ref.company_cik = tx.company_cik
  where tx.transaction_date > ref.as_of - 90
)
select
  company_cik,
  max(as_of) as as_of,
  count(*) filter (where transaction_code = 'P')                         as buy_count,
  count(*) filter (where transaction_code = 'S' and not is_10b5_1)       as sell_count,
  count(*) filter (where transaction_code = 'S' and is_10b5_1)           as planned_sell_count,
  coalesce(sum(value) filter (where transaction_code = 'P'), 0)
    - coalesce(sum(value) filter (where transaction_code = 'S' and not is_10b5_1), 0)
                                                                          as net_value,
  coalesce(sum(value) filter (where transaction_code = 'S' and is_10b5_1), 0)
                                                                          as planned_sell_value
from win
group by company_cik;

-- ---------------------------------------------------------------------------
-- fund_realtime_activity — Form 4 transactions whose reporting owner CIK is
-- itself a 13F filer (a 10%-owner fund filing insider transactions). Joined to
-- filers so the feed carries the fund's name/slug. 13D/G rows (ownership_13dg,
-- stubbed) are unioned in by a later phase.
-- ---------------------------------------------------------------------------
create view fund_realtime_activity as
select
  fl.cik              as fund_cik,
  fl.name             as fund_name,
  fl.slug             as fund_slug,
  ft.accession_no,
  ft.company_cik,
  ft.table_type,
  ft.row_index,
  ft.security_title,
  ft.transaction_code,
  ft.transaction_date,
  ft.shares,
  ft.price,
  ft.acquired_disposed,
  ft.shares_owned_after,
  ft.is_10b5_1
from form4_transactions ft
join filers fl on fl.cik = ft.insider_cik;
