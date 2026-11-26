-- Replace any older client-configurable daily limit with fixed server-side
-- quotas: five searches per authenticated user per day and 150 per project
-- per calendar month. The monthly counter is shared across all users.
create table if not exists public.search_monthly_usage (
  usage_month date primary key,
  request_count integer not null default 0 check (request_count >= 0)
);
revoke all on public.search_monthly_usage from public, anon, authenticated;
alter table public.search_monthly_usage enable row level security;

drop function if exists public.consume_search_daily_limit(integer);
create or replace function public.consume_search_daily_limit()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  updated_rows integer;
begin
  if current_user_id is null then
    return false;
  end if;

  insert into public.search_daily_usage(owner_id, usage_date, request_count)
    values (current_user_id, current_date, 0)
    on conflict (owner_id, usage_date) do nothing;
  update public.search_daily_usage
    set request_count = request_count + 1
    where owner_id = current_user_id and usage_date = current_date
      and request_count < 5;
  get diagnostics updated_rows = row_count;
  if updated_rows <> 1 then
    return false;
  end if;

  insert into public.search_monthly_usage(usage_month, request_count)
    values (date_trunc('month', current_date)::date, 0)
    on conflict (usage_month) do nothing;
  update public.search_monthly_usage
    set request_count = request_count + 1
    where usage_month = date_trunc('month', current_date)::date
      and request_count < 150;
  get diagnostics updated_rows = row_count;
  if updated_rows <> 1 then
    update public.search_daily_usage
      set request_count = request_count - 1
      where owner_id = current_user_id and usage_date = current_date;
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.consume_search_daily_limit() from public, anon, authenticated, service_role;
grant execute on function public.consume_search_daily_limit() to authenticated;
