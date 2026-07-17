-- Phase 1: 13F ingestion schema.
-- Tables per ARCHITECTURE.md, plus the filings_effective view that every
-- query reads through so superseded filings are never counted.

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- filers — 13F filing managers
-- ---------------------------------------------------------------------------
create table filers (
  cik         text primary key,
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger filers_updated_at before update on filers
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- filings — one row per SEC filing (13F now, Form 4 in Phase 3)
-- ---------------------------------------------------------------------------
create table filings (
  accession_no        text primary key,
  cik                 text not null references filers (cik),
  form_type           text not null,
  period_of_report    date not null,
  filed_at            date not null,

  -- Set only on a 13F-HR/A. The cover page does not name the filing it
  -- amends, so this is resolved from (cik, period_of_report) at load time
  -- and stays null until the original has been ingested.
  amends_accession_no text references filings (accession_no),
  amendment_type      text check (amendment_type in ('RESTATEMENT', 'NEW HOLDINGS')),

  -- True on an original that a RESTATEMENT /A has replaced.
  is_superseded       boolean not null default false,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- An amendment must say what kind it is; a non-amendment must not.
  constraint filings_amendment_type_only_on_amendment check (
    (form_type like '%/A') = (amendment_type is not null)
  )
);

create index filings_cik_period_idx on filings (cik, period_of_report);
create index filings_amends_idx on filings (amends_accession_no);

create trigger filings_updated_at before update on filings
  for each row execute function set_updated_at();

-- Every read of holdings goes through this view rather than `filings`, so a
-- restated original can never be double counted (ARCHITECTURE.md decision 3).
create view filings_effective as
  select * from filings where is_superseded = false;

-- ---------------------------------------------------------------------------
-- securities — CUSIP -> ticker cache (seeded from SEC reference data,
-- resolved via OpenFIGI). Unmapped CUSIPs must never block ingestion, so a
-- row always exists for every CUSIP a filing mentions.
-- ---------------------------------------------------------------------------
create table securities (
  cusip          text primary key,
  ticker         text,
  name           text,
  sector         text,
  mapping_status text not null default 'unmapped'
                 check (mapping_status in ('mapped', 'unmapped', 'ambiguous')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index securities_ticker_idx on securities (ticker);

create trigger securities_updated_at before update on securities
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- holdings_13f — raw information-table rows
--
-- PK note (deviates from the column list in specs/phase-1-13f-ingestion.md):
-- the spec's PK (accession_no, cusip, put_call, share_class) is not unique in
-- real filings. Berkshire reports a single security once per `otherManager`
-- combination — Apple appears 12 times in one filing, each row a different
-- sub-portfolio with its own share count and value. Across the 11 committed
-- fixtures that PK collapses 430 of 714 rows (60%), which the spec itself
-- forbids ("never collapse them").
--
-- Adding other_manager makes all 714 fixture rows distinct, but nothing in the
-- SEC schema guarantees that holds for every filer, and a PK violation would
-- abort ingestion of an otherwise valid filing. The identity of an
-- information-table row is its position in the report, so the PK is
-- (accession_no, row_index): always unique, and stable across re-ingestion
-- because an accession's documents are immutable once filed.
-- ---------------------------------------------------------------------------
create table holdings_13f (
  accession_no          text not null references filings (accession_no) on delete cascade,
  row_index             integer not null,

  cusip                 text not null references securities (cusip),
  put_call              text check (put_call in ('Put', 'Call')),
  share_class           text,
  other_manager         text,

  -- sshPrnamtType SH -> shares; PRN -> principal_amt (convertible debt).
  -- Exactly one of the two is set.
  shares                numeric,
  principal_amt         numeric,

  -- Always whole USD. Pre-2023 filings report $ thousands and are
  -- normalized at parse time (ARCHITECTURE.md decision 4).
  value_usd             numeric not null,
  investment_discretion text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  primary key (accession_no, row_index),
  constraint holdings_13f_shares_xor_principal check (
    (shares is null) <> (principal_amt is null)
  )
);

create index holdings_13f_cusip_idx on holdings_13f (cusip);
create index holdings_13f_accession_cusip_idx on holdings_13f (accession_no, cusip);

create trigger holdings_13f_updated_at before update on holdings_13f
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- companies — issuers, seeded from SEC company_tickers.json
-- ---------------------------------------------------------------------------
create table companies (
  cik                      text primary key,
  ticker                   text,
  name                     text not null,
  shares_outstanding       numeric,
  shares_outstanding_asof  date,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index companies_ticker_idx on companies (ticker);

create trigger companies_updated_at before update on companies
  for each row execute function set_updated_at();
