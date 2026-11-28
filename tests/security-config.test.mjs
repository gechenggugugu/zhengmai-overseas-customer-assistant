import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url),"utf8");
test("daily quota is fixed server-side and cannot be set by request payload", async () => {
  const sql=await read("../backend/supabase/migrations/20261126000100_lead_records.sql");
  const fn=await read("../backend/supabase/functions/leads-search/index.ts");
  assert.match(sql,/consume_search_daily_limit\(\)/);
  assert.match(sql,/request_count < 5/);
  assert.match(sql,/request_count < 150/);
  assert.doesNotMatch(sql,/p_daily_limit/);
  assert.match(fn,/reserve_search_quota/);
  assert.match(fn,/confirm_search_quota/);
  assert.doesNotMatch(fn,/SEARCH_DAILY_LIMIT/);
});

test("login email is normalized case-insensitively", async () => {
  const cloud = await read("../cloud-storage.mjs");
  assert.match(cloud,/signInWithPassword\(\{email:String\(email\)\.trim\(\)\.toLowerCase\(\), password\}\)/);
});

test("migration explicitly revokes lead table privileges before granting authenticated CRUD", async () => {
  const sql=await read("../backend/supabase/migrations/20261126000100_lead_records.sql");
  assert.match(sql,/alter table public\.lead_records enable row level security/i);
  assert.match(sql,/revoke all on table public\.lead_records from public, anon/i);
  assert.match(sql,/grant select, insert, update, delete on public\.lead_records to authenticated/i);
});

test("usage tables have RLS enabled, no client grants, and are accessed by the definer function", async () => {
  const sql=await read("../backend/supabase/migrations/20261126000100_lead_records.sql");
  for (const table of ["search_daily_usage","search_monthly_usage"]) {
    assert.match(sql,new RegExp(`revoke all on public\\.${table} from public, anon, authenticated`));
    assert.match(sql,new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.doesNotMatch(sql,/create policy[^;]*on public\.search_(daily|monthly)_usage/i);
  const quotaFn=sql.slice(sql.indexOf("create or replace function public.consume_search_daily_limit()"));
  assert.match(quotaFn,/security definer[\s\S]*?set search_path = ''/);
});

test("legacy quota RPC is removed and administrator mutations are service-role only", async () => {
  const sql=await read("../backend/deployment/staging-quota/candidate-migrations/20261128190000_special_quota_authorization_registry.sql");
  assert.match(sql,/drop function if exists public\.consume_search_daily_limit\(\)/i);
  assert.match(sql,/revoke all on function public\.admin_set_search_quota_limits\(integer\) from public, anon, authenticated, service_role/i);
  assert.match(sql,/grant execute on function public\.admin_set_search_quota_limits_server\(uuid, integer\) to service_role/i);
});

test("migration uses repeatable create/drop patterns for tables, policies, trigger and function", async () => {
  const sql=await read("../backend/supabase/migrations/20261126000100_lead_records.sql");
  assert.equal((sql.match(/create table if not exists/gi)||[]).length,3);
  assert.match(sql,/create or replace function public\.touch_lead_record_updated_at/);
  assert.match(sql,/drop trigger if exists lead_records_touch_updated_at/);
  assert.match(sql,/drop policy if exists "Users read their own lead records"/);
  assert.match(sql,/drop function if exists public\.consume_search_daily_limit\(integer\)/);
});

test("Edge Function verifies the caller JWT and uses only server credentials for quota mutations", async () => {
  const fn=await read("../backend/supabase/functions/leads-search/index.ts");
  assert.match(fn,/const bearer = authorization\.match/);
  const authBlock=fn.slice(fn.indexOf("const identity = await fetch"),fn.indexOf("const providerUrl"));
  assert.match(authBlock,/headers:\{apikey:publicKey, Authorization:"Bearer " \+ bearer\}/);
  assert.match(authBlock,/const userId = verifiedUser\?\.id/);
  const rpcBlock=fn.slice(fn.indexOf("async function quotaRpc"),fn.indexOf("async function readBodyWithinLimit"));
  assert.match(rpcBlock,/apikey:config\.key, Authorization:"Bearer " \+ config\.key/);
  assert.doesNotMatch(rpcBlock,/publicKey|bearer/);
  assert.match(fn,/p_user_id:userId, p_attempt_id:crypto\.randomUUID\(\)/);
});

test("user records have RLS and all policies bind rows to auth.uid", async () => {
  const sql=await read("../backend/supabase/migrations/20261126000100_lead_records.sql");
  assert.match(sql,/alter table public\.lead_records enable row level security/i);
  assert.ok((sql.match(/auth\.uid\(\)/g)||[]).length >= 5);
  assert.match(sql,/with check \(\(select auth\.uid\(\)\) = owner_id\)/);
});

test("function validates bearer sessions, restricts CORS and keeps secrets server-side", async () => {
  const fn=await read("../backend/supabase/functions/leads-search/index.ts");
  const config=await read("../public-config.js");
  assert.match(fn,/auth\/v1\/user/);
  assert.match(fn,/allowedOrigins\.includes\(origin\)/);
  assert.match(fn,/Deno\.env\.get\("SEARCH_API_KEY"\)/);
  assert.ok(!/SEARCH_API_KEY|service.role|secret/i.test(config),
    "Public configuration must contain only browser-safe settings");
});

test("browser hardening declares a restrictive CSP and does not persist auth token in localStorage", async () => {
  const html=await read("../index.html");
  const auth=await read("../cloud-storage.mjs");
  assert.match(html,/Content-Security-Policy/);
  assert.match(auth,/flowType:"pkce"/);
  assert.match(auth,/globalThis\.sessionStorage/);
  assert.doesNotMatch(auth,/localStorage/);
});

test("search function contains replaceable Tavily and Brave adapters and never fabricates contacts", async () => {
  const fn=await read("../backend/supabase/functions/leads-search/index.ts");
  assert.match(fn,/provider === "tavily"/);
  assert.match(fn,/provider === "brave"/);
  // One Tavily basic request per user action keeps the 150-search quota to
  // at most 150 Tavily credits rather than silently multiplying provider use.
  assert.match(fn,/const languages = \["en"\]/);
  assert.ok(fn.includes("content.match(/[A-Z0-9._%+-]+@"));
  assert.match(fn,/contact:emails\[0\] \|\| ""/);
  assert.match(fn,/source:url/);
  assert.match(fn,/matchScore:score/);
});

test("contact discovery reuses the authenticated quota path and searches both targets", async () => {
  const fn=await read("../backend/supabase/functions/leads-search/index.ts");
  const app=await read("../app.mjs");
  const service=await read("../services.mjs");
  assert.match(fn,/const contactSearch = query\?\.action === "contacts"/);
  assert.match(fn,/reserve_search_quota/);
  assert.match(fn,/Purchasing Manager OR Procurement Manager OR Import Manager OR Sourcing Manager OR Owner OR Founder OR Managing Director OR CEO/);
  assert.match(fn,/verificationStatus:"待核实"/);
  assert.match(fn,/linkedin\\\.com\$\|\(\^\|\\\.\)facebook\\\.com\$/);
  assert.match(service,/action:"contacts", company:\{name:lead\.name,website:lead\.website,market:lead\.market\}/);
  assert.match(service,/const payload = await postLiveSearch\(\{[\s\S]*?action:"contacts"/);
  assert.match(app,/record\.contacts/);
  assert.match(app,/联系人证据来源/);
  assert.doesNotMatch(fn,/SEARCH_DAILY_LIMIT/);
});
