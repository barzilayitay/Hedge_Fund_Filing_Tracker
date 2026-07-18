-- Phase 2: derived analytics.
--
-- Everything here reads through holdings_13f_agg, never raw holdings_13f
-- (Phase 2 AMENDMENT, binding). holdings_13f is row-level: a security can
-- appear many times in one filing (one row per otherManager), so a "position"
-- is the SUM of rows for (filer, period, cusip, put_call, share_class) over the
-- amendment-effective filing set.
--
-- Percentage columns (pct_of_portfolio, prior_pct_of_portfolio, pct_change,
-- pct_ownership, top10_concentration_pct, turnover_pct, sector_allocation
-- values) are all on a 0..100 scale.

-- ---------------------------------------------------------------------------
-- quarterly_prices — quarter-end closes (seed committed as
-- fixtures/prices/quarterly_prices.csv; production refresh via
-- scripts/load-prices.ts). ARCHITECTURE.md: (ticker, quarter_end) PK.
-- ---------------------------------------------------------------------------
create table quarterly_prices (
  ticker       text not null,
  quarter_end  date not null,
  close_price  numeric not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (ticker, quarter_end)
);

create trigger quarterly_prices_updated_at before update on quarterly_prices
  for each row execute function set_updated_at();

-- The PK no longer leads on cusip (holdings_13f PK is (accession_no,
-- row_index)); analytics look holdings up per security, so index cusip first
-- (Phase 2 AMENDMENT item 5). Phase 1 already has (cusip) and
-- (accession_no, cusip); this adds the recommended (cusip, accession_no).
create index if not exists holdings_13f_cusip_accession_idx
  on holdings_13f (cusip, accession_no);

-- ---------------------------------------------------------------------------
-- holdings_13f_agg — the ONE aggregation every analytic reads.
--
-- Groups raw rows to one row per position over amendment-effective filings.
-- filings_effective already excludes RESTATEMENT-superseded originals; a
-- NEW HOLDINGS period keeps both original and /A effective, so their rows are
-- unioned here (SUM). put_call is part of the grain — a put, a call and a
-- share position in the same issuer are three distinct positions and are never
-- merged.
--
-- Note: Phase 1's holdings_13f never captured voting-authority columns, so the
-- AMENDMENT sketch's "SUM(voting authority ...)" cannot be honored and no
-- Phase 2 output needs it. Recorded in PROGRESS.md.
-- ---------------------------------------------------------------------------
create view holdings_13f_agg as
  select
    f.cik,
    f.period_of_report,
    h.cusip,
    h.put_call,
    h.share_class,
    sum(h.value_usd)                        as value_usd,
    sum(h.shares)                           as shares,
    sum(h.principal_amt)                    as principal_amt,
    count(*)                                as row_count,
    bool_or(h.shares is not null)           as has_shares,
    bool_or(h.principal_amt is not null)    as has_principal
  from filings_effective f
  join holdings_13f h on h.accession_no = f.accession_no
  where f.form_type like '13F-HR%'
  group by f.cik, f.period_of_report, h.cusip, h.put_call, h.share_class;

-- ---------------------------------------------------------------------------
-- est_avg_price is computed inline in fund_holdings_enriched below (see the
-- est_avg_price column). It is deliberately NOT a function: PGlite cannot
-- resolve relations referenced from a function body that is invoked while a
-- materialized view is being populated, so the acceptance tests (which run on
-- PGlite) would fail on refresh. An inline correlated subquery over
-- holdings_13f_agg works there and on real Postgres alike.

-- ---------------------------------------------------------------------------
-- fund_holdings_enriched — one row per position per filer-quarter, plus
-- synthesized SOLD_OUT rows for positions held last quarter but not this one.
--
-- Diffs join on (cusip, put_call, share_class) so unmapped CUSIPs (null ticker)
-- still diff correctly. "Prior" is the filer's immediately preceding period
-- that has an effective filing, so amendment handling flows through for free.
-- ---------------------------------------------------------------------------
create materialized view fund_holdings_enriched as
with periods as (
  select distinct cik, period_of_report from holdings_13f_agg
),
prior_of as (
  select p.cik, p.period_of_report,
    (select max(p2.period_of_report) from periods p2
      where p2.cik = p.cik and p2.period_of_report < p.period_of_report) as prior_period
  from periods p
),
portfolio as (
  select cik, period_of_report, sum(value_usd) as portfolio_value
  from holdings_13f_agg
  group by cik, period_of_report
),
-- Current-quarter positions, left-joined to the same position last quarter.
current_pos as (
  select
    cur.cik, cur.period_of_report, cur.cusip, cur.put_call, cur.share_class,
    cur.value_usd, cur.shares, cur.principal_amt, cur.has_shares, cur.has_principal,
    po.prior_period,
    prior.value_usd     as prior_value_usd,
    prior.shares        as prior_shares,
    prior.principal_amt as prior_principal_amt,
    false               as is_sold_out
  from holdings_13f_agg cur
  join prior_of po
    on po.cik = cur.cik and po.period_of_report = cur.period_of_report
  left join holdings_13f_agg prior
    on prior.cik = cur.cik
   and prior.period_of_report = po.prior_period
   and prior.cusip = cur.cusip
   and prior.put_call is not distinct from cur.put_call
   and prior.share_class is not distinct from cur.share_class
),
-- Positions held last quarter but gone this quarter: value/shares -> 0.
sold_out_pos as (
  select
    po.cik, po.period_of_report, prior.cusip, prior.put_call, prior.share_class,
    0::numeric as value_usd,
    case when prior.has_shares then 0::numeric else null end     as shares,
    case when prior.has_principal then 0::numeric else null end  as principal_amt,
    prior.has_shares, prior.has_principal,
    po.prior_period,
    prior.value_usd     as prior_value_usd,
    prior.shares        as prior_shares,
    prior.principal_amt as prior_principal_amt,
    true                as is_sold_out
  from prior_of po
  join holdings_13f_agg prior
    on prior.cik = po.cik and prior.period_of_report = po.prior_period
  left join holdings_13f_agg cur
    on cur.cik = po.cik and cur.period_of_report = po.period_of_report
   and cur.cusip = prior.cusip
   and cur.put_call is not distinct from prior.put_call
   and cur.share_class is not distinct from prior.share_class
  where cur.cusip is null
),
positions as (
  select * from current_pos
  union all
  select * from sold_out_pos
)
select
  p.cik,
  p.period_of_report,
  p.cusip,
  s.ticker,
  s.name,
  p.put_call,
  p.share_class,
  s.sector,
  p.shares,
  p.principal_amt,
  p.value_usd as market_value,
  coalesce(p.prior_value_usd, 0) as prior_market_value,

  -- weight in the portfolio, 0..100
  round(100 * p.value_usd / nullif(port.portfolio_value, 0), 6)
    as pct_of_portfolio,
  case when p.prior_period is null then null
       else round(100 * p.prior_value_usd / nullif(prior_port.portfolio_value, 0), 6)
  end as prior_pct_of_portfolio,

  -- rank by market value within the quarter; SOLD_OUT rows are not ranked
  case when p.is_sold_out then null
       else rank() over (
         partition by p.cik, p.period_of_report, p.is_sold_out
         order by p.value_usd desc
       )
  end as rank,

  case when p.shares is null and p.prior_shares is null then null
       else coalesce(p.shares, 0) - coalesce(p.prior_shares, 0)
  end as change_in_shares,

  case when p.prior_shares is null or p.prior_shares = 0 then null
       else round(100 * (coalesce(p.shares, 0) - p.prior_shares) / p.prior_shares, 6)
  end as pct_change,

  case
    when p.is_sold_out then 'SOLD_OUT'
    when p.prior_value_usd is null then 'NEW'
    when coalesce(p.shares, p.principal_amt) = coalesce(p.prior_shares, p.prior_principal_amt)
      then 'UNCHANGED'
    when coalesce(p.shares, p.principal_amt) > coalesce(p.prior_shares, p.prior_principal_amt)
      then 'ADDED'
    else 'REDUCED'
  end as position_status,

  -- ownership of the issuer, SH rows with a mapped company only
  case
    when p.has_shares and c.shares_outstanding is not null and c.shares_outstanding > 0
      then round(100 * p.shares / c.shares_outstanding, 6)
    else null
  end as pct_ownership,

  (select min(a.period_of_report) from holdings_13f_agg a
     where a.cik = p.cik and a.cusip = p.cusip
       and a.put_call is not distinct from p.put_call
       and a.share_class is not distinct from p.share_class
       and a.period_of_report <= p.period_of_report) as qtr_first_owned,

  -- est_avg_price: share-change-weighted mean of the per-quarter price across
  -- the position's history up to this quarter (best-effort estimate, labeled as
  -- such in the UI, ARCHITECTURE.md decision 6). We hold one price per quarter
  -- (quarter-end close), used as that quarter's mean. The first quarter's whole
  -- holding is a buy at that quarter's price; each later increase is a buy at
  -- its quarter's price; decreases are ignored. If any needed price is missing,
  -- fall back to the current-quarter price. Null only for an unpriced ticker.
  case when s.ticker is null then null
    else coalesce(
      (select case
                when bool_or(b.price is null and b.buy_shares > 0) then null
                when coalesce(sum(b.buy_shares) filter (where b.buy_shares > 0), 0) = 0
                  then null
                else round(
                  sum(b.buy_shares * b.price) filter (where b.buy_shares > 0)
                  / sum(b.buy_shares) filter (where b.buy_shares > 0), 6)
              end
       from (
         select h.price,
                case when lag(h.shares) over (order by h.period) is null then h.shares
                     else greatest(h.shares - lag(h.shares) over (order by h.period), 0)
                end as buy_shares
         from (
           select a.period_of_report as period,
                  a.shares,
                  (select q.close_price from quarterly_prices q
                    where q.ticker = s.ticker and q.quarter_end = a.period_of_report)
                  as price
           from holdings_13f_agg a
           where a.cik = p.cik and a.cusip = p.cusip
             and a.put_call is not distinct from p.put_call
             and a.share_class is not distinct from p.share_class
             and a.period_of_report <= p.period_of_report
             and a.shares is not null
         ) h
       ) b
      ),
      qp.close_price
    )
  end as est_avg_price,

  qp.close_price as quarter_end_price
from positions p
left join securities s on s.cusip = p.cusip and s.mapping_status = 'mapped'
left join portfolio port
  on port.cik = p.cik and port.period_of_report = p.period_of_report
left join portfolio prior_port
  on prior_port.cik = p.cik and prior_port.period_of_report = p.prior_period
left join companies c on c.ticker = s.ticker
left join quarterly_prices qp
  on qp.ticker = s.ticker and qp.quarter_end = p.period_of_report;

-- Unique per position; also lets fund_holdings_enriched be refreshed
-- CONCURRENTLY later. (cusip, put_call, share_class) is unique within a
-- filer-quarter, and SOLD_OUT rows only exist where the position is absent
-- from the current quarter, so they never collide with a real row.
create unique index fund_holdings_enriched_pk
  on fund_holdings_enriched (cik, period_of_report, cusip, put_call, share_class);

-- ---------------------------------------------------------------------------
-- fund_quarter_summary — one row per filer-quarter.
-- ---------------------------------------------------------------------------
create view fund_quarter_summary as
with held as (  -- current holdings only (exclude synthesized SOLD_OUT rows)
  select * from fund_holdings_enriched where position_status <> 'SOLD_OUT'
),
port as (
  select cik, period_of_report, sum(market_value) as portfolio_value,
         count(*) as num_holdings
  from held group by cik, period_of_report
),
prior_port as (
  -- portfolio value of the immediately preceding quarter, for turnover
  select h.cik, h.period_of_report,
         (select sum(h2.market_value) from held h2
           where h2.cik = h.cik
             and h2.period_of_report = (
               select max(p3.period_of_report) from held p3
                where p3.cik = h.cik and p3.period_of_report < h.period_of_report))
         as prior_portfolio_value
  from held h
  group by h.cik, h.period_of_report
),
top10 as (
  select cik, period_of_report, sum(market_value) as top10_value
  from (
    select cik, period_of_report, market_value,
           row_number() over (partition by cik, period_of_report
                              order by market_value desc) as rn
    from held
  ) r
  where rn <= 10
  group by cik, period_of_report
),
-- Σ|Δvalue| across every position that appears in either quarter. Each
-- enriched row already carries this quarter's market_value and last quarter's
-- prior_market_value; NEW rows have prior 0, SOLD_OUT rows have market_value 0,
-- so every position in either quarter is counted exactly once.
value_change as (
  select cik, period_of_report,
         sum(abs(market_value - prior_market_value)) as sum_abs_delta
  from fund_holdings_enriched
  group by cik, period_of_report
),
sector_alloc as (
  select cik, period_of_report,
         jsonb_object_agg(sector_key, pct) as sector_allocation
  from (
    select cik, period_of_report,
           coalesce(sector, 'Unknown') as sector_key,
           round(100 * sum(market_value) /
                 nullif(sum(sum(market_value)) over (partition by cik, period_of_report), 0), 6) as pct
    from held
    group by cik, period_of_report, coalesce(sector, 'Unknown')
  ) s
  group by cik, period_of_report
),
new_buys as (
  select cik, period_of_report,
         jsonb_agg(item order by market_value desc) as top_new_buys
  from (
    select cik, period_of_report, market_value,
           jsonb_build_object('ticker', ticker, 'cusip', cusip,
             'share_class', share_class, 'market_value', market_value,
             'shares', shares) as item,
           row_number() over (partition by cik, period_of_report
                              order by market_value desc) as rn
    from held where position_status = 'NEW'
  ) n where rn <= 5
  group by cik, period_of_report
),
sells as (
  select cik, period_of_report,
         jsonb_agg(item order by value_dropped desc) as top_sells
  from (
    select cik, period_of_report,
           jsonb_build_object('ticker', ticker, 'cusip', cusip,
             'share_class', share_class, 'position_status', position_status,
             'value_dropped', value_dropped) as item,
           value_dropped,
           row_number() over (partition by cik, period_of_report
                              order by value_dropped desc) as rn
    from (
      select cik, period_of_report, ticker, cusip, share_class, position_status,
             prior_market_value - market_value as value_dropped
      from fund_holdings_enriched
      where position_status in ('REDUCED', 'SOLD_OUT')
    ) d
  ) s where rn <= 5 and value_dropped > 0
  group by cik, period_of_report
)
select
  port.cik,
  port.period_of_report,
  port.portfolio_value,
  port.num_holdings,
  round(100 * coalesce(top10.top10_value, 0) / nullif(port.portfolio_value, 0), 6)
    as top10_concentration_pct,
  -- turnover = 0.5 × Σ|Δvalue| / average portfolio value, as a percent.
  -- avg portfolio value = (this quarter + prior quarter) / 2. Null when there
  -- is no prior quarter (turnover undefined for a filer's first quarter).
  case when pp.prior_portfolio_value is null or pp.prior_portfolio_value = 0 then null
       else round(
         100 * 0.5 * vc.sum_abs_delta /
         ((port.portfolio_value + pp.prior_portfolio_value) / 2.0), 6)
  end as turnover_pct,
  coalesce(sa.sector_allocation, '{}'::jsonb) as sector_allocation,
  coalesce(nb.top_new_buys, '[]'::jsonb) as top_new_buys,
  coalesce(sl.top_sells, '[]'::jsonb) as top_sells
from port
left join prior_port pp on pp.cik = port.cik and pp.period_of_report = port.period_of_report
left join top10 on top10.cik = port.cik and top10.period_of_report = port.period_of_report
left join value_change vc on vc.cik = port.cik and vc.period_of_report = port.period_of_report
left join sector_alloc sa on sa.cik = port.cik and sa.period_of_report = port.period_of_report
left join new_buys nb on nb.cik = port.cik and nb.period_of_report = port.period_of_report
left join sells sl on sl.cik = port.cik and sl.period_of_report = port.period_of_report;

-- ---------------------------------------------------------------------------
-- refresh_derived — rebuild the materialized analytics after ingest.
-- ---------------------------------------------------------------------------
create function refresh_derived() returns void
language plpgsql as $$
begin
  refresh materialized view fund_holdings_enriched;
end;
$$;
