-- Run after the 001/002 structural baseline and before migration 003.
-- Keep authenticated users' normal lead-record CRUD, but remove table-wide
-- operations that bypass row-level security and retire the legacy quota RPC.
do $precondition$
begin
  if pg_catalog.to_regclass('public.lead_records') is null then
    raise exception 'quota_acl_precondition_failed: public.lead_records is missing';
  end if;
  if not pg_catalog.has_table_privilege('authenticated','public.lead_records','SELECT')
     or not pg_catalog.has_table_privilege('authenticated','public.lead_records','INSERT')
     or not pg_catalog.has_table_privilege('authenticated','public.lead_records','UPDATE')
     or not pg_catalog.has_table_privilege('authenticated','public.lead_records','DELETE') then
    raise exception 'quota_acl_precondition_failed: authenticated lead CRUD is not the audited baseline';
  end if;
  if not exists (select 1 from pg_catalog.pg_policies where schemaname='public'
    and tablename='lead_records' and policyname='Users read their own lead records'
    and cmd='SELECT' and roles @> array['authenticated']::name[]
    and qual ilike '%auth.uid()%owner_id%')
     or (select count(*) from pg_catalog.pg_policies where schemaname='public' and tablename='lead_records') <> 4 then
    raise exception 'quota_acl_precondition_failed: lead_records owner RLS policies differ from audited baseline';
  end if;
  if pg_catalog.to_regclass('public.search_quota_settings') is not null
     or pg_catalog.to_regclass('public.search_quota_reservations') is not null
     or pg_catalog.to_regclass('public.search_quota_policy_version') is not null
     or pg_catalog.to_regclass('public.search_quota_special_users') is not null
     or pg_catalog.to_regclass('public.search_response_cache') is not null then
    raise exception 'quota_acl_precondition_failed: quota rollout already exists; reconcile before applying';
  end if;
  if pg_catalog.to_regprocedure('public.consume_search_daily_limit()') is null then
    raise exception 'quota_acl_precondition_failed: expected legacy consumer is absent; reconcile before applying';
  end if;
  if not pg_catalog.has_function_privilege('authenticated','public.consume_search_daily_limit()','EXECUTE')
     or pg_catalog.has_function_privilege('anon','public.consume_search_daily_limit()','EXECUTE') then
    raise exception 'quota_acl_precondition_failed: legacy consumer grants differ from audited baseline';
  end if;
  if exists (select 1 from pg_catalog.pg_proc as p
             join pg_catalog.pg_namespace as n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname in
             ('reserve_search_quota','confirm_search_quota','refund_search_quota',
              'admin_set_search_quota_limits','admin_set_shelly_user')) then
    raise exception 'quota_acl_precondition_failed: unexpected quota write RPC exists; reconcile before applying';
  end if;
end;
$precondition$;

revoke truncate, trigger, references on table public.lead_records from public, anon, authenticated;
revoke execute on function public.consume_search_daily_limit() from public, anon, authenticated, service_role;

do $postcondition$
begin
  if pg_catalog.has_table_privilege('authenticated', 'public.lead_records', 'TRUNCATE') then
    raise exception 'quota_acl_postcondition_failed: authenticated retains lead_records TRUNCATE';
  end if;
  if pg_catalog.has_table_privilege('authenticated', 'public.lead_records', 'TRIGGER')
     or pg_catalog.has_table_privilege('authenticated', 'public.lead_records', 'REFERENCES') then
    raise exception 'quota_acl_postcondition_failed: authenticated retains unnecessary trigger/reference privilege';
  end if;
  if not pg_catalog.has_table_privilege('authenticated', 'public.lead_records', 'SELECT')
     or not pg_catalog.has_table_privilege('authenticated', 'public.lead_records', 'INSERT')
     or not pg_catalog.has_table_privilege('authenticated', 'public.lead_records', 'UPDATE')
     or not pg_catalog.has_table_privilege('authenticated', 'public.lead_records', 'DELETE') then
    raise exception 'quota_acl_postcondition_failed: lead_records CRUD grants changed';
  end if;
  if pg_catalog.to_regprocedure('public.consume_search_daily_limit()') is not null
     and pg_catalog.has_function_privilege('authenticated', 'public.consume_search_daily_limit()', 'EXECUTE') then
    raise exception 'quota_acl_postcondition_failed: authenticated can still call legacy quota RPC';
  end if;
  if pg_catalog.to_regprocedure('public.consume_search_daily_limit()') is not null
     and (pg_catalog.has_function_privilege('anon','public.consume_search_daily_limit()','EXECUTE')
       or pg_catalog.has_function_privilege('service_role','public.consume_search_daily_limit()','EXECUTE')) then
    raise exception 'quota_acl_postcondition_failed: legacy consumer remains executable by an API role';
  end if;
end;
$postcondition$;
