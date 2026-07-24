-- Phase 4: read API layer.
--
-- Six read-only RPC functions over the Phase 2/3 derived data, plus the RLS +
-- grant model that lets the anon role reach the data ONLY through these
-- functions and a short list of derived views — never a base table.
--
-- Design notes (see specs/phase-4-api.md and PROGRESS.md Phase 4 decisions):
--   * Every RPC returns a single `jsonb` value. This makes the wire shape an
--     explicit contract (zod-parsed in lib/api.ts), lets one call carry both
--     `rows` and `total_count`/summary data, and is stable against later column
--     additions to the underlying views.
--   * All are `security definer` and owned by the migration role (which owns the
--     tables), so they bypass RLS to read the base data on the caller's behalf.
--     `set search_path` is pinned so a caller cannot shadow objects.
--   * `get_fund_holdings` sorts and paginates server-side. sort_col is checked
--     against a hard whitelist and sort_dir against {asc,desc} before it is
--     interpolated, so there is no SQL injection via the sort parameters; every
--     data value is passed with EXECUTE ... USING.
--   * Percentages are already 0..100 (Phase 2 Decision 4); nothing here rescales.

-- ---------------------------------------------------------------------------
-- anon role. On Supabase this role is pre-provisioned; create it conditionally
-- so the same migration also runs on a bare Postgres / PGlite (the test engine)
-- where it does not exist yet. nologin: it is assumed via the API gateway, not
-- connected to directly.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
end
$$;

grant usage on schema public to anon;

-- ---------------------------------------------------------------------------
-- get_fund_holdings — enriched holdings for one fund-quarter, sorted, filtered
-- and paginated server-side. Returns { fund, quarter, total_count, rows }.
-- ---------------------------------------------------------------------------
create function get_fund_holdings(
  fund_slug text,
  quarter date,
  sort_col text default 'market_value',
  sort_dir text default 'desc',
  page integer default 1,
  page_size integer default 50,
  search text default null
) returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_allowed   text[] := array[
    'ticker', 'name', 'sector', 'put_call', 'share_class', 'market_value',
    'prior_market_value', 'pct_of_portfolio', 'prior_pct_of_portfolio', 'rank',
    'shares', 'principal_amt', 'change_in_shares', 'pct_change',
    'position_status', 'pct_ownership', 'qtr_first_owned', 'est_avg_price',
    'quarter_end_price', 'cusip'
  ];
  v_dir       text;
  v_cik       text;
  v_fund      jsonb;
  v_offset    bigint;
  v_search    text;
  v_where     text;
  v_total     integer;
  v_rows      jsonb;
begin
  if not (sort_col = any (v_allowed)) then
    raise exception 'invalid sort_col: %', sort_col using errcode = '22023';
  end if;
  v_dir := lower(sort_dir);
  if v_dir not in ('asc', 'desc') then
    raise exception 'invalid sort_dir: %', sort_dir using errcode = '22023';
  end if;

  if page < 1 then page := 1; end if;
  -- Cap page so an anon-controlled value cannot overflow the offset (integer
  -- multiplication would raise SQLSTATE 22003 and leak a plpgsql context). One
  -- million pages is already far beyond any real dataset.
  if page > 1000000 then page := 1000000; end if;
  if page_size < 1 then page_size := 50; end if;
  if page_size > 500 then page_size := 500; end if;
  -- bigint arithmetic; v_offset is bigint so the product never overflows int4.
  v_offset := (page::bigint - 1) * page_size;
  v_search := case when search is null or search = '' then null
                   else '%' || search || '%' end;

  select jsonb_build_object('cik', cik, 'name', name, 'slug', slug)
    into v_fund
    from filers where slug = fund_slug;

  if v_fund is null then
    return jsonb_build_object('fund', null, 'quarter', quarter,
                              'total_count', 0, 'rows', '[]'::jsonb);
  end if;
  v_cik := v_fund->>'cik';

  v_where := $w$
    e.cik = $1
    and e.period_of_report = $2
    and ($3::text is null or e.ticker ilike $3 or e.name ilike $3)
  $w$;

  execute format('select count(*) from fund_holdings_enriched e where %s', v_where)
    into v_total using v_cik, quarter, v_search;

  execute format($f$
    with filtered as (
      select
        e.cik, e.period_of_report, e.cusip, e.ticker, e.name, e.put_call,
        e.share_class, e.sector, e.shares, e.principal_amt, e.market_value,
        e.prior_market_value, e.pct_of_portfolio, e.prior_pct_of_portfolio,
        e.rank, e.change_in_shares, e.pct_change, e.position_status,
        e.pct_ownership, e.qtr_first_owned, e.est_avg_price, e.quarter_end_price
      from fund_holdings_enriched e
      where %s
    ),
    page as (
      select * from filtered
      order by %I %s nulls last, cusip asc
      limit $4 offset $5
    )
    select coalesce(
      jsonb_agg(to_jsonb(page) order by %I %s nulls last, cusip asc),
      '[]'::jsonb)
    from page
  $f$, v_where, sort_col, v_dir, sort_col, v_dir)
  into v_rows using v_cik, quarter, v_search, page_size, v_offset;

  return jsonb_build_object(
    'fund', v_fund,
    'quarter', quarter,
    'total_count', v_total,
    'rows', coalesce(v_rows, '[]'::jsonb)
  );
end
$$;

-- ---------------------------------------------------------------------------
-- get_fund_summary — the fund_quarter_summary row for one quarter, plus the
-- list of quarters the fund has data for. Returns { fund, quarter, summary,
-- quarters }.
-- ---------------------------------------------------------------------------
create function get_fund_summary(
  fund_slug text,
  quarter date default null
) returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_fund     jsonb;
  v_cik      text;
  v_quarter  date := quarter;
  v_quarters jsonb;
  v_summary  jsonb;
begin
  select jsonb_build_object('cik', cik, 'name', name, 'slug', slug)
    into v_fund from filers where slug = fund_slug;
  if v_fund is null then
    return jsonb_build_object('fund', null, 'quarter', quarter,
                              'summary', null, 'quarters', '[]'::jsonb);
  end if;
  v_cik := v_fund->>'cik';

  select coalesce(jsonb_agg(period_of_report order by period_of_report desc), '[]'::jsonb)
    into v_quarters
    from (select distinct period_of_report
            from fund_quarter_summary where cik = v_cik) q;

  -- Default to the latest available quarter when none is requested.
  if v_quarter is null then
    select max(period_of_report) into v_quarter
      from fund_quarter_summary where cik = v_cik;
  end if;

  select to_jsonb(s) into v_summary
    from (
      select cik, period_of_report, portfolio_value, num_holdings,
             top10_concentration_pct, turnover_pct, sector_allocation,
             top_new_buys, top_sells
        from fund_quarter_summary
       where cik = v_cik and period_of_report = v_quarter
    ) s;

  return jsonb_build_object(
    'fund', v_fund,
    'quarter', v_quarter,
    'summary', v_summary,
    'quarters', v_quarters
  );
end
$$;

-- ---------------------------------------------------------------------------
-- get_fund_realtime — Form 4 feed for a 10%-owner fund (the fund itself is the
-- reporting owner). Returns { fund, rows } newest-first. Empty rows when the
-- slug is not a fund that files Form 4s.
-- ---------------------------------------------------------------------------
create function get_fund_realtime(
  fund_slug text,
  row_limit integer default 50
) returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
-- Params (fund_slug) share names with columns; resolve bare refs to the column
-- and reach the param via the qualified get_fund_realtime.fund_slug.
#variable_conflict use_column
declare
  v_fund jsonb;
  v_rows jsonb;
begin
  select jsonb_build_object('cik', cik, 'name', name, 'slug', slug)
    into v_fund from filers where slug = fund_slug;
  if v_fund is null then
    return jsonb_build_object('fund', null, 'rows', '[]'::jsonb);
  end if;

  if row_limit < 1 then row_limit := 50; end if;
  if row_limit > 500 then row_limit := 500; end if;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.transaction_date desc nulls last,
                            r.accession_no, r.table_type, r.row_index), '[]'::jsonb)
    into v_rows
    from (
      select fund_cik, fund_name, fund_slug, accession_no, company_cik,
             table_type, row_index, security_title, transaction_code,
             transaction_date, shares, price, acquired_disposed,
             shares_owned_after, is_10b5_1
        from fund_realtime_activity
       where fund_slug = get_fund_realtime.fund_slug
       order by transaction_date desc nulls last, accession_no, table_type, row_index
       limit row_limit
    ) r;

  return jsonb_build_object('fund', v_fund, 'rows', coalesce(v_rows, '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------
-- get_stock_institutional — the funds holding a ticker in a given quarter, with
-- their position changes, paginated by market value desc. Returns
-- { ticker, quarter, total_count, rows }. SOLD_OUT positions (fund exited) are
-- excluded — this is "who holds it now".
-- ---------------------------------------------------------------------------
create function get_stock_institutional(
  ticker text,
  quarter date,
  page integer default 1,
  page_size integer default 50
) returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_offset integer;
  v_total  integer;
  v_rows   jsonb;
begin
  if page < 1 then page := 1; end if;
  if page_size < 1 then page_size := 50; end if;
  if page_size > 500 then page_size := 500; end if;
  v_offset := (page - 1) * page_size;

  select count(*) into v_total
    from fund_holdings_enriched e
   where e.ticker = get_stock_institutional.ticker
     and e.period_of_report = quarter
     and e.position_status <> 'SOLD_OUT';

  select coalesce(jsonb_agg(to_jsonb(r) order by r.market_value desc nulls last,
                            r.fund_slug), '[]'::jsonb)
    into v_rows
    from (
      select f.cik as fund_cik, f.name as fund_name, f.slug as fund_slug,
             e.put_call, e.share_class, e.shares, e.market_value,
             e.pct_of_portfolio, e.change_in_shares, e.pct_change,
             e.position_status, e.rank, e.pct_ownership
        from fund_holdings_enriched e
        join filers f on f.cik = e.cik
       where e.ticker = get_stock_institutional.ticker
         and e.period_of_report = quarter
         and e.position_status <> 'SOLD_OUT'
       order by e.market_value desc nulls last, f.slug
       limit page_size offset v_offset
    ) r;

  return jsonb_build_object(
    'ticker', ticker,
    'quarter', quarter,
    'total_count', v_total,
    'rows', coalesce(v_rows, '[]'::jsonb)
  );
end
$$;

-- ---------------------------------------------------------------------------
-- get_stock_insiders — Form 4 rows for the issuer behind a ticker, paginated
-- and optionally filtered by transaction code, plus the sentiment summary and
-- an active-cluster flag. Returns { ticker, company_cik, total_count, rows,
-- sentiment, has_active_cluster }.
--
-- ticker -> issuer CIK via `companies` (cik seeded from company_tickers.json,
-- 10-digit zero-padded, same normalization as form4_transactions.company_cik).
-- ---------------------------------------------------------------------------
create function get_stock_insiders(
  ticker text,
  page integer default 1,
  page_size integer default 50,
  codes text[] default null
) returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
-- Params (ticker) share names with columns; resolve bare refs to the column and
-- reach the param via the qualified get_stock_insiders.ticker.
#variable_conflict use_column
declare
  v_cik       text;
  v_offset    integer;
  v_total     integer;
  v_rows      jsonb;
  v_sentiment jsonb;
  v_cluster   boolean;
begin
  if page < 1 then page := 1; end if;
  if page_size < 1 then page_size := 50; end if;
  if page_size > 500 then page_size := 500; end if;
  v_offset := (page - 1) * page_size;

  select cik into v_cik
    from companies where ticker = get_stock_insiders.ticker
    order by cik limit 1;

  if v_cik is null then
    return jsonb_build_object('ticker', ticker, 'company_cik', null,
      'total_count', 0, 'rows', '[]'::jsonb, 'sentiment', null,
      'has_active_cluster', false);
  end if;

  select count(*) into v_total
    from form4_transactions ft
   where ft.company_cik = v_cik
     and (codes is null or array_length(codes, 1) is null
          or ft.transaction_code = any (codes));

  select coalesce(jsonb_agg(to_jsonb(r)
           order by r.transaction_date desc nulls last, r.accession_no,
                    r.table_type, r.row_index), '[]'::jsonb)
    into v_rows
    from (
      select ft.accession_no, ft.insider_cik, i.name as insider_name,
             ft.company_cik, ft.table_type, ft.row_index, ft.security_title,
             ft.transaction_code, ft.transaction_date, ft.shares, ft.price,
             ft.acquired_disposed, ft.shares_owned_after, ft.direct_indirect,
             ft.nature_of_ownership, ft.is_10b5_1,
             ft.conversion_or_exercise_price, ft.exercise_date,
             ft.expiration_date, ft.underlying_security_title,
             ft.underlying_shares, ft.footnotes
        from form4_transactions ft
        join insiders i on i.cik = ft.insider_cik
       where ft.company_cik = v_cik
         and (codes is null or array_length(codes, 1) is null
              or ft.transaction_code = any (codes))
       order by ft.transaction_date desc nulls last, ft.accession_no,
                ft.table_type, ft.row_index
       limit page_size offset v_offset
    ) r;

  select to_jsonb(s) into v_sentiment
    from (
      select company_cik, as_of, buy_count, sell_count, planned_sell_count,
             net_value, planned_sell_value
        from insider_sentiment where company_cik = v_cik
    ) s;

  select exists (select 1 from insider_cluster_buys where company_cik = v_cik)
    into v_cluster;

  return jsonb_build_object(
    'ticker', ticker,
    'company_cik', v_cik,
    'total_count', v_total,
    'rows', coalesce(v_rows, '[]'::jsonb),
    'sentiment', v_sentiment,
    'has_active_cluster', v_cluster
  );
end
$$;

-- ---------------------------------------------------------------------------
-- get_confluence — overlay of institutional and insider activity for a ticker,
-- shaped for charting. Returns { ticker, from_quarter, institutional, insiders }:
--   institutional: per quarter (>= from_quarter), net Σ change_in_shares across
--                  all funds, fund count, and total market value.
--   insiders:      individual open-market (P/S) insider transactions for the
--                  issuer on/after from_quarter, with per-row value.
-- ---------------------------------------------------------------------------
create function get_confluence(
  ticker text,
  from_quarter date
) returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
-- Params (ticker) share names with columns; resolve bare refs to the column and
-- reach the param via the qualified get_confluence.ticker.
#variable_conflict use_column
declare
  v_cik           text;
  v_institutional jsonb;
  v_insiders      jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(q) order by q.quarter), '[]'::jsonb)
    into v_institutional
    from (
      select e.period_of_report as quarter,
             sum(e.change_in_shares) as net_share_change,
             count(*) filter (where e.position_status <> 'SOLD_OUT') as num_funds,
             sum(e.market_value) as total_market_value
        from fund_holdings_enriched e
       where e.ticker = get_confluence.ticker
         and e.period_of_report >= from_quarter
       group by e.period_of_report
    ) q;

  select cik into v_cik
    from companies where ticker = get_confluence.ticker
    order by cik limit 1;

  if v_cik is not null then
    select coalesce(jsonb_agg(to_jsonb(t)
             order by t.transaction_date, t.accession_no, t.row_index), '[]'::jsonb)
      into v_insiders
      from (
        select ft.transaction_date, ft.insider_cik, i.name as insider_name,
               ft.transaction_code, ft.shares, ft.price, ft.acquired_disposed,
               ft.is_10b5_1,
               coalesce(ft.shares, 0) * coalesce(ft.price, 0) as value,
               ft.accession_no, ft.row_index
          from form4_transactions ft
          join insiders i on i.cik = ft.insider_cik
         where ft.company_cik = v_cik
           and ft.transaction_code in ('P', 'S')
           and ft.transaction_date is not null
           and ft.transaction_date >= from_quarter
      ) t;
  else
    v_insiders := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'ticker', ticker,
    'from_quarter', from_quarter,
    'institutional', coalesce(v_institutional, '[]'::jsonb),
    'insiders', coalesce(v_insiders, '[]'::jsonb)
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Security: expose data to anon ONLY through the six security-definer RPCs.
-- Nothing else — no base table, no view, no other function — is reachable.
--
-- This is layered so no single mistake reopens the surface, and — critically —
-- so it is robust against the two ways the gate-review found the surface had
-- leaked open:
--
--   * Supabase ships a default ACL (pg_default_acl) that auto-grants
--     D/x/t/m (TRUNCATE/TRIGGER/REFERENCES/MAINTAIN — MAINTAIN alone lets a
--     role REFRESH a matview) to anon on every relation the migration role
--     creates in `public`. A per-table `revoke` that only names base tables
--     leaves every VIEW and MATERIALIZED VIEW carrying those default grants.
--     We revoke ALL on ALL tables (relkind r, v AND m) from anon+public, and
--     `alter default privileges` so relations created LATER are not re-granted.
--
--   * Postgres grants EXECUTE to PUBLIC on every new function by default. A
--     helper from an earlier phase (refresh_derived, set_updated_at) was
--     therefore PUBLIC-executable and became anon-reachable the moment the anon
--     role was created here — an inert Phase 2 grant turned into a live
--     unauthenticated write/DoS primitive. We revoke EXECUTE from PUBLIC on
--     every function first, alter default privileges for future functions, and
--     then grant EXECUTE back on exactly the six intended RPCs.
--
-- RLS is additionally enabled (no policies) on every base table so a leaked
-- grant still yields zero rows. The migration role owns the tables and
-- functions and has BYPASSRLS, so the security-definer RPCs read on anon's
-- behalf; loader/test sessions run as the owner and are unaffected.
-- ---------------------------------------------------------------------------

-- 1. RLS on every base table, catalog-driven so a table added later is never
--    silently left unprotected (the invariant is also asserted by a test).
do $$
declare
  t regclass;
begin
  for t in
    select c.oid
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table %s enable row level security', t);
  end loop;
end
$$;

-- 2. Revoke every privilege on every table/view/matview from anon and public.
--    "all tables" in Postgres covers relkind r, v and m, so this closes the
--    default-ACL leak on the views as well as the base tables.
revoke all on all tables in schema public from anon, public;

-- 3. Stop objects created LATER in this schema from being auto-granted to
--    anon/public (both relations and functions).
alter default privileges in schema public revoke all on tables from anon, public;
alter default privileges in schema public revoke execute on functions from anon, public;

-- 4. Revoke EXECUTE broadly, then grant it back on only the six RPCs. This is
--    what keeps refresh_derived()/set_updated_at() (and any future helper) off
--    the anon surface unless it is deliberately granted here.
revoke execute on all functions in schema public from public;
revoke execute on function refresh_derived() from public, anon;
revoke execute on function set_updated_at() from public, anon;

grant execute on function get_fund_holdings(text, date, text, text, integer, integer, text) to anon;
grant execute on function get_fund_summary(text, date) to anon;
grant execute on function get_fund_realtime(text, integer) to anon;
grant execute on function get_stock_institutional(text, date, integer, integer) to anon;
grant execute on function get_stock_insiders(text, integer, integer, text[]) to anon;
grant execute on function get_confluence(text, date) to anon;
