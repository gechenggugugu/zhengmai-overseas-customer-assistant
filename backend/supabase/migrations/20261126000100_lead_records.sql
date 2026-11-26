create table if not exists public.lead_records (
  owner_id uuid not null references auth.users(id) on delete cascade,
  record_key text not null check (length(record_key) between 1 and 512),
  record jsonb not null check (jsonb_typeof(record) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (owner_id, record_key)
);

create or replace function public.touch_lead_record_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  new.record = jsonb_set(new.record, '{updatedAt}', to_jsonb(new.updated_at::text), true);
  return new;
end;
$$;

revoke all on function public.touch_lead_record_updated_at() from public, anon, authenticated;
drop trigger if exists lead_records_touch_updated_at on public.lead_records;
create trigger lead_records_touch_updated_at
  before insert or update on public.lead_records
  for each row execute function public.touch_lead_record_updated_at();

alter table public.lead_records enable row level security;
grant select, insert, update, delete on public.lead_records to authenticated;

drop policy if exists "Users read their own lead records" on public.lead_records;
create policy "Users read their own lead records"
  on public.lead_records for select to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "Users create their own lead records" on public.lead_records;
create policy "Users create their own lead records"
  on public.lead_records for insert to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users update their own lead records" on public.lead_records;
create policy "Users update their own lead records"
  on public.lead_records for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users delete their own lead records" on public.lead_records;
create policy "Users delete their own lead records"
  on public.lead_records for delete to authenticated
  using ((select auth.uid()) = owner_id);

create table if not exists public.search_daily_usage (
  owner_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default current_date,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (owner_id, usage_date)
);
revoke all on public.search_daily_usage from public, anon, authenticated;

create or replace function public.consume_search_daily_limit(p_daily_limit integer default 50)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  updated_rows integer;
begin
  if current_user_id is null or p_daily_limit < 1 or p_daily_limit > 1000 then
    return false;
  end if;
  insert into public.search_daily_usage(owner_id, usage_date, request_count)
    values (current_user_id, current_date, 0)
    on conflict (owner_id, usage_date) do nothing;
  update public.search_daily_usage
    set request_count = request_count + 1
    where owner_id = current_user_id and usage_date = current_date
      and request_count < p_daily_limit;
  get diagnostics updated_rows = row_count;
  return updated_rows = 1;
end;
$$;
revoke all on function public.consume_search_daily_limit(integer) from public, anon;
grant execute on function public.consume_search_daily_limit(integer) to authenticated;
