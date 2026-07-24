-- Docker-gated security check (real Supabase Postgres) — anon-surface assertions.
--
-- Run with psql -v ON_ERROR_STOP=1 so any RAISE aborts with a non-zero exit.
-- Each check names the specific offending object(s) in its failure message.
--
-- WHY this runs on real Supabase and not in the PGlite suite: PGlite cannot
-- reproduce Supabase provisioning artifacts — notably pg_default_acl, which
-- auto-grants privileges (incl. MAINTAIN) to anon on owner-created relations.
-- A view-grant leak that only appears on real Supabase is therefore invisible
-- to the standing PGlite security tests. Origin: Phase 4 gate review #1
-- (BLOCKER-2). Do not delete this as CI cruft — see ARCHITECTURE.md "CI".

\echo '== check (i): anon EXECUTE surface == exactly the six intended RPCs =='
do $$
declare
  intended text[] := array[
    'get_fund_holdings', 'get_fund_summary', 'get_fund_realtime',
    'get_stock_institutional', 'get_stock_insiders', 'get_confluence'
  ];
  extra   text;
  missing text;
begin
  -- Any function anon can EXECUTE that is NOT one of the six.
  select string_agg(p.proname, ', ' order by p.proname) into extra
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and not (p.proname = any (intended));
  if extra is not null then
    raise exception 'anon can EXECUTE unintended function(s): %', extra;
  end if;

  -- Any of the six that anon can NOT execute.
  select string_agg(x, ', ' order by x) into missing
    from (
      select unnest(intended) as x
      except
      select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and has_function_privilege('anon', p.oid, 'EXECUTE')
    ) m;
  if missing is not null then
    raise exception 'anon is MISSING EXECUTE on intended RPC(s): %', missing;
  end if;

  raise notice 'OK: anon executes exactly the six RPCs';
end
$$;

\echo '== check (ii): zero anon/public grants on any table/view/matview =='
do $$
declare
  bad text;
begin
  select string_agg(
           format('%s(%s):%s',
                  c.relname,
                  case c.relkind when 'r' then 'table'
                                 when 'v' then 'view'
                                 when 'm' then 'matview' end,
                  case when pr.grantee = 0 then 'PUBLIC'
                       else pr.grantee::regrole::text end || '/' || pr.privilege_type),
           ', ')
    into bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) pr
   where n.nspname = 'public'
     and c.relkind in ('r', 'v', 'm')
     and pr.grantee in (0, 'anon'::regrole);
  if bad is not null then
    raise exception 'anon/public hold grant(s) on relation(s): %', bad;
  end if;
  raise notice 'OK: no anon/public grant on any relation';
end
$$;

\echo '== check (iii): RLS enabled on every base table in schema public =='
do $$
declare
  bad text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and not c.relrowsecurity;
  if bad is not null then
    raise exception 'RLS is DISABLED on base table(s): %', bad;
  end if;
  raise notice 'OK: RLS enabled on every base table';
end
$$;

\echo 'ALL anon-surface state checks passed.'
