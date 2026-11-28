-- Incremental quota policy and shared search cache. Do not rewrite migrations 001-003.
-- All quota dates and reset instants use UTC.
do $migration$
begin
  if pg_catalog.to_regclass('public.search_daily_usage') is null
     or pg_catalog.to_regclass('public.search_monthly_usage') is null
     or pg_catalog.to_regclass('public.search_quota_settings') is null
     or pg_catalog.to_regclass('public.search_quota_reservations') is null
     or pg_catalog.to_regprocedure('public.reserve_search_quota(uuid)') is null then
    raise exception 'quota_prerequisites_missing: apply migrations 20261126000100 through 20261126000300 first';
  end if;
end;
$migration$;

alter table public.search_quota_settings alter column monthly_limit set default 1000;
create table if not exists public.search_quota_policy_version (
  singleton boolean primary key default true check (singleton),
  version integer not null check (version >= 1),
  applied_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table public.search_quota_policy_version enable row level security;
revoke all on public.search_quota_policy_version from public, anon, authenticated, service_role;
do $policy_upgrade$
begin
  if not exists (select 1 from public.search_quota_policy_version as policy where policy.singleton = true) then
    -- Fix the normal-user cap as part of this policy rollout. Admin and Shelly
    -- limits are role/UUID overrides in the RPCs below; existing usage rows
    -- remain untouched.
    update public.search_quota_settings as settings
       set daily_limit = 5, monthly_limit = 1000,
           updated_at = pg_catalog.clock_timestamp()
     where settings.singleton = true;
    insert into public.search_quota_policy_version(singleton, version) values (true, 1)
      on conflict (singleton) do nothing;
  end if;
end;
$policy_upgrade$;

-- Shelly receives unlimited daily searches only after an administrator assigns
-- the actual Auth UUID here. An empty table means nobody has this exception.
create table if not exists public.search_quota_special_users (
  slot text primary key default 'shelly' check (slot = 'shelly'),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);
revoke all on public.search_quota_special_users from public, anon, authenticated, service_role;
alter table public.search_quota_special_users enable row level security;

-- Shared result cache is writable only by the Edge Function's server-side
-- service role. Browser users cannot read, poison, or alter cached results.
create table if not exists public.search_response_cache (
  cache_key text primary key check (cache_key ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider in ('tavily', 'brave')),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  provider_credits integer check (provider_credits is null or provider_credits >= 0),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);
create index if not exists search_response_cache_expiry_idx
  on public.search_response_cache (expires_at);
revoke all on public.search_response_cache from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.search_response_cache to service_role;
alter table public.search_response_cache enable row level security;

create or replace function public.get_search_quota_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := auth.uid();
  is_admin boolean := coalesce(auth.jwt()->'app_metadata'->>'role' = 'admin', false);
  configured_shelly_id uuid;
  is_shelly boolean := false;
  utc_now timestamptz := pg_catalog.clock_timestamp();
  utc_date date := pg_catalog.timezone('UTC', utc_now)::date;
  utc_month date := pg_catalog.date_trunc('month', pg_catalog.timezone('UTC', utc_now))::date;
  daily_cap integer;
  monthly_cap integer;
  daily_used integer := 0;
  monthly_used integer := 0;
  daily_remaining integer;
  monthly_remaining integer;
  remaining integer;
begin
  if current_user_id is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  select settings.daily_limit, settings.monthly_limit into daily_cap, monthly_cap
    from public.search_quota_settings as settings where settings.singleton = true;
  if not found then raise exception 'quota_settings_missing' using errcode = '55000'; end if;
  select special.user_id into configured_shelly_id from public.search_quota_special_users as special
   where special.slot = 'shelly';
  is_shelly := configured_shelly_id is not null and configured_shelly_id = current_user_id;
  if is_admin then daily_cap := 60;
  elsif is_shelly then daily_cap := null;
  end if;

  perform public.expire_search_quota_reservations();
  select usage.request_count into daily_used from public.search_daily_usage as usage
   where usage.owner_id = current_user_id and usage.usage_date = utc_date;
  select usage.request_count into monthly_used from public.search_monthly_usage as usage
   where usage.usage_month = utc_month;
  daily_remaining := case when daily_cap is null then null else greatest(0, daily_cap - coalesce(daily_used, 0)) end;
  monthly_remaining := greatest(0, monthly_cap - coalesce(monthly_used, 0));
  remaining := case when daily_remaining is null then monthly_remaining else least(daily_remaining, monthly_remaining) end;
  return pg_catalog.jsonb_build_object(
    'today_used', coalesce(daily_used, 0), 'daily_limit', daily_cap,
    'today_remaining', daily_remaining, 'daily_unlimited', daily_cap is null,
    'is_admin', is_admin, 'is_shelly_user', is_shelly,
    'shelly_user_configured', configured_shelly_id is not null,
    'shelly_user_id', case when is_admin then configured_shelly_id else null end,
    'month_used', coalesce(monthly_used, 0), 'monthly_limit', monthly_cap,
    'month_remaining', monthly_remaining, 'remaining', remaining,
    'daily_resets_at', ((utc_date + 1)::timestamp) at time zone 'UTC',
    'monthly_resets_at', ((utc_month + interval '1 month')::timestamp) at time zone 'UTC');
end;
$$;

-- Admin daily quota is a fixed 60; this RPC can change only the shared project cap.
create or replace function public.admin_set_search_quota_limits(p_monthly_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  if coalesce(auth.jwt()->'app_metadata'->>'role' = 'admin', false) is not true then
    raise exception 'admin_required' using errcode = '42501';
  end if;
  if p_monthly_limit is null or p_monthly_limit not between 1 and 1000 then
    raise exception 'monthly_quota_out_of_range' using errcode = '22023';
  end if;
  update public.search_quota_settings as settings set monthly_limit = p_monthly_limit,
    updated_at = pg_catalog.clock_timestamp() where settings.singleton = true;
  if not found then raise exception 'quota_settings_missing' using errcode = '55000'; end if;
  return public.get_search_quota_status();
end;
$$;

-- Keep the old two-argument admin RPC temporarily compatible with already-open
-- clients. Its daily argument is validated but ignored; role-based 60 stays fixed.
create or replace function public.admin_set_search_quota_limits(p_daily_limit integer, p_monthly_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_daily_limit is null or p_daily_limit not between 1 and 1000 then
    raise exception 'daily_quota_argument_invalid' using errcode = '22023';
  end if;
  return public.admin_set_search_quota_limits(p_monthly_limit);
end;
$$;

create or replace function public.admin_set_shelly_user(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  if coalesce(auth.jwt()->'app_metadata'->>'role' = 'admin', false) is not true then
    raise exception 'admin_required' using errcode = '42501';
  end if;
  if p_user_id is null then
    delete from public.search_quota_special_users as special where special.slot = 'shelly';
  else
    if not exists (select 1 from auth.users as users where users.id = p_user_id) then
      raise exception 'auth_user_not_found' using errcode = '22023';
    end if;
    insert into public.search_quota_special_users(slot, user_id, created_by, created_at)
    values ('shelly', p_user_id, current_user_id, pg_catalog.clock_timestamp())
    on conflict (slot) do update set user_id = excluded.user_id,
      created_by = excluded.created_by, created_at = excluded.created_at;
  end if;
  return public.get_search_quota_status();
end;
$$;

create or replace function public.reserve_search_quota(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := auth.uid();
  is_admin boolean := coalesce(auth.jwt()->'app_metadata'->>'role' = 'admin', false);
  configured_shelly_id uuid;
  is_shelly boolean := false;
  utc_now timestamptz := pg_catalog.clock_timestamp();
  utc_date date := pg_catalog.timezone('UTC', utc_now)::date;
  utc_month date := pg_catalog.date_trunc('month', pg_catalog.timezone('UTC', utc_now))::date;
  daily_cap integer;
  monthly_cap integer;
  daily_used integer := 0;
  monthly_used integer := 0;
  daily_remaining integer;
  monthly_remaining integer;
  prior_status text;
  prior_expiry timestamptz;
begin
  if current_user_id is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  if p_request_id is null then raise exception 'request_id_required' using errcode = '22023'; end if;
  select settings.daily_limit, settings.monthly_limit into daily_cap, monthly_cap
    from public.search_quota_settings as settings where settings.singleton = true for share;
  if not found then raise exception 'quota_settings_missing' using errcode = '55000'; end if;
  select special.user_id into configured_shelly_id from public.search_quota_special_users as special
   where special.slot = 'shelly' for share;
  is_shelly := configured_shelly_id is not null and configured_shelly_id = current_user_id;
  if is_admin then daily_cap := 60;
  elsif is_shelly then daily_cap := null;
  end if;

  insert into public.search_monthly_usage(usage_month, request_count)
  values (utc_month, 0) on conflict (usage_month) do nothing;
  insert into public.search_daily_usage(owner_id, usage_date, request_count)
  values (current_user_id, utc_date, 0) on conflict (owner_id, usage_date) do nothing;
  -- Serialize on the shared project/month row, then the caller's daily row.
  perform usage.request_count from public.search_monthly_usage as usage
   where usage.usage_month = utc_month for update;
  perform usage.request_count from public.search_daily_usage as usage
   where usage.owner_id = current_user_id and usage.usage_date = utc_date for update;
  perform public.expire_search_quota_reservations();

  select reservation.status, reservation.expires_at into prior_status, prior_expiry
    from public.search_quota_reservations as reservation
   where reservation.owner_id = current_user_id and reservation.request_id = p_request_id for update;
  if found then
    select usage.request_count into daily_used from public.search_daily_usage as usage
     where usage.owner_id = current_user_id and usage.usage_date = utc_date;
    select usage.request_count into monthly_used from public.search_monthly_usage as usage
     where usage.usage_month = utc_month;
    daily_remaining := case when daily_cap is null then null else greatest(0, daily_cap - coalesce(daily_used, 0)) end;
    monthly_remaining := greatest(0, monthly_cap - coalesce(monthly_used, 0));
    return pg_catalog.jsonb_build_object('ok', false,
      'reason', case when prior_status = 'reserved' and prior_expiry > utc_now then 'duplicate_request' else 'request_closed' end,
      'duplicate', true, 'request_id', p_request_id, 'status', prior_status,
      'today_used', coalesce(daily_used, 0), 'daily_limit', daily_cap, 'today_remaining', daily_remaining,
      'daily_unlimited', daily_cap is null, 'is_admin', is_admin, 'is_shelly_user', is_shelly,
      'month_used', coalesce(monthly_used, 0), 'monthly_limit', monthly_cap,
      'month_remaining', monthly_remaining,
      'remaining', case when daily_remaining is null then monthly_remaining else least(daily_remaining, monthly_remaining) end,
      'daily_resets_at', ((utc_date + 1)::timestamp) at time zone 'UTC',
      'monthly_resets_at', ((utc_month + interval '1 month')::timestamp) at time zone 'UTC');
  end if;

  select usage.request_count into daily_used from public.search_daily_usage as usage
   where usage.owner_id = current_user_id and usage.usage_date = utc_date;
  select usage.request_count into monthly_used from public.search_monthly_usage as usage
   where usage.usage_month = utc_month;
  if (daily_cap is not null and daily_used >= daily_cap) or monthly_used >= monthly_cap then
    daily_remaining := case when daily_cap is null then null else greatest(0, daily_cap - daily_used) end;
    monthly_remaining := greatest(0, monthly_cap - monthly_used);
    return pg_catalog.jsonb_build_object('ok', false,
      'reason', case when daily_cap is not null and daily_used >= daily_cap then 'daily' else 'monthly' end,
      'duplicate', false, 'today_used', daily_used, 'daily_limit', daily_cap, 'today_remaining', daily_remaining,
      'daily_unlimited', daily_cap is null, 'is_admin', is_admin, 'is_shelly_user', is_shelly,
      'month_used', monthly_used, 'monthly_limit', monthly_cap, 'month_remaining', monthly_remaining,
      'remaining', case when daily_remaining is null then monthly_remaining else least(daily_remaining, monthly_remaining) end,
      'daily_resets_at', ((utc_date + 1)::timestamp) at time zone 'UTC',
      'monthly_resets_at', ((utc_month + interval '1 month')::timestamp) at time zone 'UTC');
  end if;

  update public.search_daily_usage as usage set request_count = usage.request_count + 1
   where usage.owner_id = current_user_id and usage.usage_date = utc_date;
  update public.search_monthly_usage as usage set request_count = usage.request_count + 1
   where usage.usage_month = utc_month;
  insert into public.search_quota_reservations(owner_id, request_id, usage_date, usage_month, status, created_at, expires_at)
  values (current_user_id, p_request_id, utc_date, utc_month, 'reserved', utc_now, utc_now + interval '5 minutes');
  daily_remaining := case when daily_cap is null then null else greatest(0, daily_cap - daily_used - 1) end;
  monthly_remaining := greatest(0, monthly_cap - monthly_used - 1);
  return pg_catalog.jsonb_build_object('ok', true, 'reason', null, 'duplicate', false,
    'request_id', p_request_id, 'status', 'reserved',
    'today_used', daily_used + 1, 'daily_limit', daily_cap, 'today_remaining', daily_remaining,
    'daily_unlimited', daily_cap is null, 'is_admin', is_admin, 'is_shelly_user', is_shelly,
    'month_used', monthly_used + 1, 'monthly_limit', monthly_cap, 'month_remaining', monthly_remaining,
    'remaining', case when daily_remaining is null then monthly_remaining else least(daily_remaining, monthly_remaining) end,
    'daily_resets_at', ((utc_date + 1)::timestamp) at time zone 'UTC',
    'monthly_resets_at', ((utc_month + interval '1 month')::timestamp) at time zone 'UTC');
end;
$$;

revoke all on function public.get_search_quota_status() from public, anon, authenticated, service_role;
revoke all on function public.admin_set_search_quota_limits(integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_search_quota_limits(integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_shelly_user(uuid) from public, anon, authenticated, service_role;
revoke all on function public.reserve_search_quota(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_search_quota_status() to authenticated;
grant execute on function public.admin_set_search_quota_limits(integer) to authenticated;
grant execute on function public.admin_set_search_quota_limits(integer, integer) to authenticated;
grant execute on function public.admin_set_shelly_user(uuid) to authenticated;
