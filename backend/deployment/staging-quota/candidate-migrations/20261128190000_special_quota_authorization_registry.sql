-- Replace identity literals with a separately owner-controlled authorization list.
-- Apply only after a Staging backup/restore gate and verified migration preflight.
begin;
do $preflight$
begin
  if pg_catalog.to_regclass('public.search_quota_special_users') is null
     or pg_catalog.to_regclass('public.search_quota_settings') is null
     or pg_catalog.to_regclass('public.search_quota_reservations') is null
     or pg_catalog.to_regprocedure('public.search_quota_is_admin(uuid)') is null
     or pg_catalog.to_regprocedure('public.get_search_quota_status()') is null
     or pg_catalog.to_regprocedure('public.reserve_search_quota(uuid, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('public.admin_set_search_quota_limits(integer)') is null
     or pg_catalog.to_regprocedure('public.admin_set_shelly_user(uuid)') is null then
    raise exception 'special_user_authorization_prerequisites_missing';
  end if;
end;
$preflight$;

create table if not exists public.search_quota_authorized_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  authorized_at timestamptz not null default pg_catalog.clock_timestamp(),
  authorized_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz
);
alter table public.search_quota_authorized_users enable row level security;
revoke all on public.search_quota_authorized_users from public, anon, authenticated, service_role;

-- Preserve the already-active slot; owner review must verify the current migration ledger and binding before rollout.
insert into public.search_quota_authorized_users(user_id, authorized_at, authorized_by)
select special.user_id, special.created_at, special.created_by
  from public.search_quota_special_users as special
 where special.slot = 'shelly'
on conflict (user_id) do nothing;
create or replace function public.get_search_quota_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := auth.uid();
  is_admin boolean := public.search_quota_is_admin(current_user_id);
  configured_shelly_id uuid;
  is_shelly boolean := false;
  utc_now timestamptz := pg_catalog.transaction_timestamp();
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
  select 5, least(settings.monthly_limit, 1000) into daily_cap, monthly_cap
    from public.search_quota_settings as settings where settings.singleton = true;
  if not found then raise exception 'quota_settings_missing' using errcode = '55000'; end if;
  select special.user_id into configured_shelly_id from public.search_quota_special_users as special
    join public.search_quota_authorized_users as authorized on authorized.user_id = special.user_id
   where special.slot = 'shelly' and authorized.revoked_at is null;
  is_shelly := configured_shelly_id is not null and configured_shelly_id = current_user_id;
  if is_shelly then daily_cap := null;
  elsif is_admin then daily_cap := 60;
  end if;

  -- Recover orphaned reservations from the previous UTC month at rollover.
  if exists (select 1 from public.search_quota_reservations as reservation
             where reservation.usage_month < utc_month and reservation.status = 'reserved'
               and reservation.expires_at <= utc_now) then
    perform public.expire_search_quota_reservations(pending.usage_month)
      from (select distinct reservation.usage_month
              from public.search_quota_reservations as reservation
             where reservation.usage_month < utc_month and reservation.status = 'reserved'
               and reservation.expires_at <= utc_now
             order by reservation.usage_month) as pending;
  end if;
  perform public.expire_search_quota_reservations(utc_month);
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
    'shelly_user_configured', case when is_admin then configured_shelly_id is not null else null end,
    'month_used', coalesce(monthly_used, 0), 'monthly_limit', monthly_cap,
    'month_remaining', monthly_remaining, 'remaining', remaining,
    'daily_resets_at', ((utc_date + 1)::timestamp) at time zone 'UTC',
    'monthly_resets_at', ((utc_month + interval '1 month')::timestamp) at time zone 'UTC');
end;
$$;

create or replace function public.reserve_search_quota(p_request_id uuid, p_user_id uuid, p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := p_user_id;
  is_admin boolean := public.search_quota_is_admin(current_user_id);
  configured_shelly_id uuid;
  is_shelly boolean := false;
  utc_now timestamptz := pg_catalog.transaction_timestamp();
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
  if p_request_id is null or p_attempt_id is null then raise exception 'request_id_required' using errcode = '22023'; end if;
  select 5, least(settings.monthly_limit, 1000) into daily_cap, monthly_cap
    from public.search_quota_settings as settings where settings.singleton = true for share;
  if not found then raise exception 'quota_settings_missing' using errcode = '55000'; end if;
  select special.user_id into configured_shelly_id from public.search_quota_special_users as special
    join public.search_quota_authorized_users as authorized on authorized.user_id = special.user_id
   where special.slot = 'shelly' and authorized.revoked_at is null for share;
  is_shelly := configured_shelly_id is not null and configured_shelly_id = current_user_id;
  if is_shelly then daily_cap := null;
  elsif is_admin then daily_cap := 60;
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
  perform public.expire_search_quota_reservations(utc_month);
  utc_now := pg_catalog.clock_timestamp();

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

  -- Claim the globally unique request before touching either counter.
  insert into public.search_quota_reservations
    (owner_id, request_id, attempt_id, usage_date, usage_month, status, created_at, expires_at)
  values (current_user_id, p_request_id, p_attempt_id, utc_date, utc_month, 'reserved',
          utc_now, utc_now + interval '5 minutes')
  on conflict (request_id) do nothing;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'request_closed', 'duplicate', true);
  end if;
  update public.search_daily_usage as usage set request_count = usage.request_count + 1
   where usage.owner_id = current_user_id and usage.usage_date = utc_date;
  update public.search_monthly_usage as usage set request_count = usage.request_count + 1
   where usage.usage_month = utc_month;

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

create or replace function public.admin_set_search_quota_limits_server(
  p_admin_user_id uuid,
  p_monthly_limit integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_admin_user_id is null or public.search_quota_is_admin(p_admin_user_id) is not true then
    raise exception 'admin_required' using errcode = '42501';
  end if;
  if p_monthly_limit is null or p_monthly_limit not between 1 and 1000 then
    raise exception 'monthly_quota_out_of_range' using errcode = '22023';
  end if;
  update public.search_quota_settings as settings
     set monthly_limit = p_monthly_limit, updated_at = pg_catalog.clock_timestamp()
   where settings.singleton = true;
  if not found then raise exception 'quota_settings_missing' using errcode = '55000'; end if;
  return pg_catalog.jsonb_build_object('monthly_limit', p_monthly_limit);
end;
$$;

create or replace function public.search_quota_authorize_special_user(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null then raise exception 'special_user_id_required' using errcode = '22023'; end if;
  if not exists (select 1 from auth.users as users where users.id = p_user_id) then
    raise exception 'special_auth_user_not_found' using errcode = '22023';
  end if;
  insert into public.search_quota_authorized_users(user_id, authorized_at)
  values (p_user_id, pg_catalog.clock_timestamp())
  on conflict (user_id) do update set authorized_at = excluded.authorized_at, revoked_at = null;
  return pg_catalog.jsonb_build_object('authorized', true);
end;
$$;

create or replace function public.search_quota_revoke_special_user_authorization(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null then raise exception 'special_user_id_required' using errcode = '22023'; end if;
  update public.search_quota_authorized_users
     set revoked_at = pg_catalog.clock_timestamp()
   where user_id = p_user_id and revoked_at is null;
  return pg_catalog.jsonb_build_object('authorized', false, 'changed', found);
end;
$$;

revoke all on function public.search_quota_authorize_special_user(uuid) from public, anon, authenticated, service_role;
revoke all on function public.search_quota_revoke_special_user_authorization(uuid) from public, anon, authenticated, service_role;
create or replace function public.admin_set_shelly_user_server(
  p_admin_user_id uuid,
  p_user_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_admin_user_id is null or public.search_quota_is_admin(p_admin_user_id) is not true then
    raise exception 'admin_required' using errcode = '42501';
  end if;
  if p_user_id is null then
    delete from public.search_quota_special_users as special where special.slot = 'shelly';
    return pg_catalog.jsonb_build_object('configured', false);
  end if;
  perform 1 from public.search_quota_authorized_users as authorized
   where authorized.user_id = p_user_id and authorized.revoked_at is null for share;
  if not found then
    raise exception 'special_user_not_authorized' using errcode = '42501';
  end if;
  insert into public.search_quota_special_users(slot, user_id, created_by, created_at)
  values ('shelly', p_user_id, p_admin_user_id, pg_catalog.clock_timestamp())
  on conflict (slot) do update set user_id = excluded.user_id,
    created_by = excluded.created_by, created_at = excluded.created_at;
  return pg_catalog.jsonb_build_object('configured', true);
end;
$$;
revoke all on function public.admin_set_search_quota_limits(integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_search_quota_limits(integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_shelly_user(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_search_quota_limits_server(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_shelly_user_server(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_search_quota_limits_server(uuid, integer) to service_role;
grant execute on function public.admin_set_shelly_user_server(uuid, uuid) to service_role;

drop function if exists public.consume_search_daily_limit();
drop function if exists public.consume_search_daily_limit(integer);
commit;
