-- Search quota reservation/settlement. All usage dates and reset instants are UTC.
-- Requires migrations 20261126000100 and 20261126000200.
-- COALESCE/GREATEST/LEAST are PostgreSQL syntax forms, not schema-qualified functions.
do $migration$
begin
  if pg_catalog.to_regclass('public.search_daily_usage') is null
     or pg_catalog.to_regclass('public.search_monthly_usage') is null then
    raise exception 'search_usage_tables_missing: apply migrations 20261126000100 and 20261126000200 first';
  end if;
end;
$migration$;

create table if not exists public.search_quota_settings (
  singleton boolean primary key default true check (singleton),
  daily_limit integer not null default 5 check (daily_limit between 1 and 1000),
  monthly_limit integer not null default 150 check (monthly_limit between 1 and 100000),
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);
insert into public.search_quota_settings(singleton, daily_limit, monthly_limit)
values (true, 5, 150) on conflict (singleton) do nothing;

create table if not exists public.search_quota_reservations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  usage_date date not null,
  usage_month date not null,
  status text not null check (status in ('reserved', 'consumed', 'refunded', 'expired')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  finished_at timestamptz,
  primary key (owner_id, request_id),
  unique (request_id),
  check (usage_month = pg_catalog.date_trunc('month', usage_date::timestamp)::date),
  check (expires_at > created_at)
);
-- PostgreSQL places an index in its parent table schema; index names cannot be schema-qualified.
create index if not exists search_quota_reservations_pending_month_idx
  on public.search_quota_reservations (usage_month, expires_at) where status = 'reserved';
revoke all on public.search_quota_settings from public, anon, authenticated, service_role;
revoke all on public.search_quota_reservations from public, anon, authenticated, service_role;
alter table public.search_quota_settings enable row level security;
alter table public.search_quota_reservations enable row level security;

-- Mark abandoned reservations expired and release their aggregate counters.
create or replace function public.expire_search_quota_reservations()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  utc_now timestamptz := pg_catalog.clock_timestamp();
  utc_month date := pg_catalog.date_trunc('month', pg_catalog.timezone('UTC', utc_now))::date;
  expired_count integer := 0;
begin
  insert into public.search_monthly_usage(usage_month, request_count)
  values (utc_month, 0) on conflict (usage_month) do nothing;
  perform usage.request_count from public.search_monthly_usage as usage
   where usage.usage_month = utc_month for update;
  with expired as (
    update public.search_quota_reservations as reservation
       set status = 'expired', finished_at = utc_now
     where reservation.usage_month = utc_month and reservation.status = 'reserved'
       and reservation.expires_at <= utc_now
    returning reservation.owner_id, reservation.usage_date
  ), daily_delta as (
    select expired.owner_id, expired.usage_date, pg_catalog.count(*)::integer as amount
      from expired group by expired.owner_id, expired.usage_date
  ), daily_update as (
    update public.search_daily_usage as usage
       set request_count = greatest(0, usage.request_count - daily_delta.amount)
      from daily_delta
     where usage.owner_id = daily_delta.owner_id and usage.usage_date = daily_delta.usage_date
    returning 1
  )
  update public.search_monthly_usage as usage
     set request_count = greatest(0, usage.request_count -
       (select pg_catalog.count(*)::integer from expired))
   where usage.usage_month = utc_month;
  select pg_catalog.count(*)::integer into expired_count
    from public.search_quota_reservations as reservation
   where reservation.usage_month = utc_month and reservation.status = 'expired'
     and reservation.finished_at = utc_now;
  return coalesce(expired_count, 0);
end;
$$;

create or replace function public.get_search_quota_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := auth.uid();
  utc_now timestamptz := pg_catalog.clock_timestamp();
  utc_date date := pg_catalog.timezone('UTC', utc_now)::date;
  utc_month date := pg_catalog.date_trunc('month', pg_catalog.timezone('UTC', utc_now))::date;
  daily_cap integer;
  monthly_cap integer;
  daily_used integer := 0;
  monthly_used integer := 0;
begin
  if current_user_id is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  select settings.daily_limit, settings.monthly_limit into daily_cap, monthly_cap
    from public.search_quota_settings as settings where settings.singleton = true;
  if not found then raise exception 'quota_settings_missing' using errcode = '55000'; end if;
  perform public.expire_search_quota_reservations();
  select usage.request_count into daily_used from public.search_daily_usage as usage
   where usage.owner_id = current_user_id and usage.usage_date = utc_date;
  select usage.request_count into monthly_used from public.search_monthly_usage as usage
   where usage.usage_month = utc_month;
  return pg_catalog.jsonb_build_object(
    'today_used', coalesce(daily_used, 0), 'daily_limit', daily_cap,
    'month_used', coalesce(monthly_used, 0), 'monthly_limit', monthly_cap,
    'remaining', greatest(0, least(daily_cap - coalesce(daily_used, 0), monthly_cap - coalesce(monthly_used, 0))),
    'daily_resets_at', ((utc_date + 1)::timestamp) at time zone 'UTC',
    'monthly_resets_at', ((utc_month + interval '1 month')::timestamp) at time zone 'UTC',
    'is_admin', coalesce(auth.jwt()->'app_metadata'->>'role' = 'admin', false));
end;
$$;

create or replace function public.admin_set_search_quota_limits(p_daily_limit integer, p_monthly_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  if coalesce(auth.jwt()->'app_metadata'->>'role' = 'admin', false) is not true then
    raise exception 'admin_required' using errcode = '42501';
  end if;
  if p_daily_limit is null or p_daily_limit not between 1 and 1000
     or p_monthly_limit is null or p_monthly_limit not between 1 and 100000 then
    raise exception 'quota_out_of_range' using errcode = '22023';
  end if;
  update public.search_quota_settings as settings
     set daily_limit = p_daily_limit, monthly_limit = p_monthly_limit,
         updated_at = pg_catalog.clock_timestamp()
   where settings.singleton = true;
  if not found then raise exception 'quota_settings_missing' using errcode = '55000'; end if;
  return public.get_search_quota_status();
end;
$$;

-- Repeating reserve for the same user/request_id reuses the original reservation.
create or replace function public.reserve_search_quota(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := auth.uid();
  utc_now timestamptz := pg_catalog.clock_timestamp();
  utc_date date := pg_catalog.timezone('UTC', utc_now)::date;
  utc_month date := pg_catalog.date_trunc('month', pg_catalog.timezone('UTC', utc_now))::date;
  daily_cap integer;
  monthly_cap integer;
  daily_used integer := 0;
  monthly_used integer := 0;
  prior_status text;
  prior_expiry timestamptz;
begin
  if current_user_id is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  if p_request_id is null then raise exception 'request_id_required' using errcode = '22023'; end if;
  select settings.daily_limit, settings.monthly_limit into daily_cap, monthly_cap
    from public.search_quota_settings as settings where settings.singleton = true;
  if not found then raise exception 'quota_settings_missing' using errcode = '55000'; end if;

  insert into public.search_monthly_usage(usage_month, request_count)
  values (utc_month, 0) on conflict (usage_month) do nothing;
  insert into public.search_daily_usage(owner_id, usage_date, request_count)
  values (current_user_id, utc_date, 0) on conflict (owner_id, usage_date) do nothing;
  -- Shared month lock first, then per-user day lock: concurrent reservations
  -- cannot cross the 150 project-wide cap or deadlock on opposite lock order.
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
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'reason', case when prior_status = 'reserved' and prior_expiry > utc_now then 'duplicate_request' else 'request_closed' end,
      'duplicate', true, 'request_id', p_request_id, 'status', prior_status,
      'today_used', coalesce(daily_used, 0), 'daily_limit', daily_cap,
      'month_used', coalesce(monthly_used, 0), 'monthly_limit', monthly_cap,
      'remaining', greatest(0, least(daily_cap - coalesce(daily_used, 0), monthly_cap - coalesce(monthly_used, 0))),
      'daily_resets_at', ((utc_date + 1)::timestamp) at time zone 'UTC',
      'monthly_resets_at', ((utc_month + interval '1 month')::timestamp) at time zone 'UTC');
  end if;

  select usage.request_count into daily_used from public.search_daily_usage as usage
   where usage.owner_id = current_user_id and usage.usage_date = utc_date;
  select usage.request_count into monthly_used from public.search_monthly_usage as usage
   where usage.usage_month = utc_month;
  if daily_used >= daily_cap or monthly_used >= monthly_cap then
    return pg_catalog.jsonb_build_object('ok', false,
      'reason', case when daily_used >= daily_cap then 'daily' else 'monthly' end,
      'duplicate', false, 'today_used', daily_used, 'daily_limit', daily_cap,
      'month_used', monthly_used, 'monthly_limit', monthly_cap,
      'remaining', greatest(0, least(daily_cap - daily_used, monthly_cap - monthly_used)),
      'daily_resets_at', ((utc_date + 1)::timestamp) at time zone 'UTC',
      'monthly_resets_at', ((utc_month + interval '1 month')::timestamp) at time zone 'UTC');
  end if;
  update public.search_daily_usage as usage set request_count = usage.request_count + 1
   where usage.owner_id = current_user_id and usage.usage_date = utc_date;
  update public.search_monthly_usage as usage set request_count = usage.request_count + 1
   where usage.usage_month = utc_month;
  insert into public.search_quota_reservations(owner_id, request_id, usage_date, usage_month, status, created_at, expires_at)
  values (current_user_id, p_request_id, utc_date, utc_month, 'reserved', utc_now, utc_now + interval '5 minutes');
  return pg_catalog.jsonb_build_object('ok', true, 'reason', null, 'duplicate', false,
    'request_id', p_request_id, 'status', 'reserved',
    'today_used', daily_used + 1, 'daily_limit', daily_cap,
    'month_used', monthly_used + 1, 'monthly_limit', monthly_cap,
    'remaining', greatest(0, least(daily_cap - daily_used - 1, monthly_cap - monthly_used - 1)),
    'daily_resets_at', ((utc_date + 1)::timestamp) at time zone 'UTC',
    'monthly_resets_at', ((utc_month + interval '1 month')::timestamp) at time zone 'UTC');
end;
$$;

create or replace function public.confirm_search_quota(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := auth.uid();
  reservation_date date;
  reservation_month date;
  reservation_status text;
  reservation_expiry timestamptz;
  utc_now timestamptz := pg_catalog.clock_timestamp();
begin
  if current_user_id is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  if p_request_id is null then raise exception 'request_id_required' using errcode = '22023'; end if;
  select reservation.usage_date, reservation.usage_month into reservation_date, reservation_month
    from public.search_quota_reservations as reservation
   where reservation.owner_id = current_user_id and reservation.request_id = p_request_id;
  if not found then return pg_catalog.jsonb_build_object('confirmed', false, 'reason', 'not_found'); end if;
  perform usage.request_count from public.search_monthly_usage as usage where usage.usage_month = reservation_month for update;
  perform usage.request_count from public.search_daily_usage as usage
   where usage.owner_id = current_user_id and usage.usage_date = reservation_date for update;
  select reservation.status, reservation.expires_at into reservation_status, reservation_expiry
    from public.search_quota_reservations as reservation
   where reservation.owner_id = current_user_id and reservation.request_id = p_request_id for update;
  if reservation_status = 'consumed' then
    return pg_catalog.jsonb_build_object('confirmed', true, 'duplicate', true, 'request_id', p_request_id);
  end if;
  if reservation_status <> 'reserved' then
    return pg_catalog.jsonb_build_object('confirmed', false, 'reason', reservation_status, 'request_id', p_request_id);
  end if;
  if reservation_expiry <= utc_now then
    update public.search_quota_reservations as reservation set status = 'expired', finished_at = utc_now
     where reservation.owner_id = current_user_id and reservation.request_id = p_request_id;
    update public.search_daily_usage as usage set request_count = greatest(0, usage.request_count - 1)
     where usage.owner_id = current_user_id and usage.usage_date = reservation_date;
    update public.search_monthly_usage as usage set request_count = greatest(0, usage.request_count - 1)
     where usage.usage_month = reservation_month;
    return pg_catalog.jsonb_build_object('confirmed', false, 'reason', 'expired', 'request_id', p_request_id);
  end if;
  update public.search_quota_reservations as reservation set status = 'consumed', finished_at = utc_now
   where reservation.owner_id = current_user_id and reservation.request_id = p_request_id;
  return pg_catalog.jsonb_build_object('confirmed', true, 'duplicate', false, 'request_id', p_request_id);
end;
$$;

create or replace function public.refund_search_quota(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := auth.uid();
  reservation_date date;
  reservation_month date;
  reservation_status text;
  utc_now timestamptz := pg_catalog.clock_timestamp();
begin
  if current_user_id is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  if p_request_id is null then raise exception 'request_id_required' using errcode = '22023'; end if;
  select reservation.usage_date, reservation.usage_month into reservation_date, reservation_month
    from public.search_quota_reservations as reservation
   where reservation.owner_id = current_user_id and reservation.request_id = p_request_id;
  if not found then return pg_catalog.jsonb_build_object('refunded', false, 'duplicate', false, 'reason', 'not_found'); end if;
  -- Keep the same lock order as reserve/confirm for concurrent settlement.
  perform usage.request_count from public.search_monthly_usage as usage where usage.usage_month = reservation_month for update;
  perform usage.request_count from public.search_daily_usage as usage
   where usage.owner_id = current_user_id and usage.usage_date = reservation_date for update;
  select reservation.status into reservation_status
    from public.search_quota_reservations as reservation
   where reservation.owner_id = current_user_id and reservation.request_id = p_request_id for update;
  if reservation_status = 'reserved' then
    update public.search_quota_reservations as reservation set status = 'refunded', finished_at = utc_now
     where reservation.owner_id = current_user_id and reservation.request_id = p_request_id;
    update public.search_daily_usage as usage set request_count = greatest(0, usage.request_count - 1)
     where usage.owner_id = current_user_id and usage.usage_date = reservation_date;
    update public.search_monthly_usage as usage set request_count = greatest(0, usage.request_count - 1)
     where usage.usage_month = reservation_month;
    return pg_catalog.jsonb_build_object('refunded', true, 'duplicate', false, 'request_id', p_request_id);
  end if;
  return pg_catalog.jsonb_build_object('refunded', false,
    'duplicate', reservation_status in ('refunded', 'expired'),
    'reason', case when reservation_status in ('refunded', 'expired') then 'already_refunded' else 'already_confirmed' end,
    'request_id', p_request_id);
end;
$$;

-- Drop legacy irreversible entry points without CASCADE. If an unknown database
-- object depends on them, PostgreSQL aborts this migration rather than breaking it.
drop function if exists public.consume_search_daily_limit();
drop function if exists public.consume_search_daily_limit(integer);

revoke all on function public.expire_search_quota_reservations() from public, anon, authenticated, service_role;
revoke all on function public.get_search_quota_status() from public, anon, authenticated, service_role;
revoke all on function public.admin_set_search_quota_limits(integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.reserve_search_quota(uuid) from public, anon, authenticated, service_role;
revoke all on function public.confirm_search_quota(uuid) from public, anon, authenticated, service_role;
revoke all on function public.refund_search_quota(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_search_quota_status() to authenticated;
grant execute on function public.admin_set_search_quota_limits(integer, integer) to authenticated;
grant execute on function public.reserve_search_quota(uuid) to authenticated;
grant execute on function public.confirm_search_quota(uuid) to authenticated;
grant execute on function public.refund_search_quota(uuid) to authenticated;
