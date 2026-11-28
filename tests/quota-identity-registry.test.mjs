import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("identity registry migration is identity-free, private and server gated", async () => {
  const sql = await read("../backend/deployment/staging-quota/candidate-migrations/20261128190000_special_quota_authorization_registry.sql");
  assert.match(sql, /begin;[\s\S]*create table if not exists public\.search_quota_authorized_users/);
  assert.match(sql, /revoked_at timestamptz/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on public\.search_quota_authorized_users from public, anon, authenticated, service_role/);
  assert.match(sql, /insert into public\.search_quota_authorized_users\(user_id, authorized_at, authorized_by\)[\s\S]*special\.created_by/);
  assert.equal((sql.match(/join public\.search_quota_authorized_users as authorized/g) || []).length, 2);
  assert.match(sql, /perform 1 from public\.search_quota_authorized_users as authorized[\s\S]*for share;[\s\S]*if not found then[\s\S]*special_user_not_authorized/);
  assert.match(sql, /create or replace function public\.search_quota_authorize_special_user\(p_user_id uuid\)[\s\S]*?security definer set search_path = '' as \$\$/);
  assert.match(sql, /create or replace function public\.search_quota_revoke_special_user_authorization\(p_user_id uuid\)[\s\S]*?security definer set search_path = '' as \$\$/);
  assert.match(sql, /create or replace function public\.admin_set_search_quota_limits_server\([\s\S]*?security definer set search_path = '' as \$\$/);
  for (const name of ["search_quota_authorize_special_user", "search_quota_revoke_special_user_authorization"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\(uuid\\) from public, anon, authenticated, service_role`));
  }
  assert.match(sql, /revoke all on function public\.admin_set_shelly_user\(uuid\) from public, anon, authenticated, service_role/);
  assert.match(sql, /grant execute on function public\.admin_set_search_quota_limits_server\(uuid, integer\) to service_role/);
  assert.match(sql, /grant execute on function public\.admin_set_shelly_user_server\(uuid, uuid\) to service_role/);
  assert.match(sql, /drop function if exists public\.consume_search_daily_limit\(\);/);
  assert.match(sql, /drop function if exists public\.consume_search_daily_limit\(integer\);/);
  assert.doesNotMatch(sql, /drop function[^;]*cascade/i);
  assert.doesNotMatch(sql, /\b(drop|truncate)\s+table\b|delete\s+from\s+public\.(?:lead_records|search_daily_usage|search_monthly_usage|search_quota_reservations)/i);
  assert.doesNotMatch(sql, /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i);
  assert.doesNotMatch(sql, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
});
