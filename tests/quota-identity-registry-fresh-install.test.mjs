import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import test from "node:test";

const engine = process.env.QUOTA_TEST_PGLITE_PATH;
const migrations = new URL("../backend/supabase/migrations/", import.meta.url);
const candidate = new URL("../backend/deployment/staging-quota/candidate-migrations/20261128190000_special_quota_authorization_registry.sql", import.meta.url);

test("identity-neutral quota migration installs after 002 without the private legacy admin migration", {skip: !engine}, async () => {
  const {PGlite} = await import(pathToFileURL(engine).href);
  const db = new PGlite();
  try {
    await db.exec(`
      set time zone 'UTC';
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key, email text, raw_app_meta_data jsonb not null default '{}');
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    `);
    for (const name of ["20261126000100_lead_records.sql", "20261126000200_search_quota_limits.sql", "20261126000250_search_quota_access_hardening.sql", "20261126000300_search_quota_management.sql", "20261127000100_search_quota_policy_cache.sql", "20261127000200_search_quota_server_access.sql"]) {
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
    }
    const user = randomUUID(), admin = randomUUID(), special = randomUUID();
    await db.query(`insert into auth.users(id,raw_app_meta_data) values ($1,'{}'),($2,'{"role":"admin"}'),($3,'{}')`, [user,admin,special]);
    await db.exec(await readFile(candidate, "utf8"));

    const {rows:[acl]} = await db.query(`
      select has_function_privilege('authenticated','public.admin_set_shelly_user(uuid)','execute') as old_shelly_callable,
             has_function_privilege('service_role','public.admin_set_search_quota_limits_server(uuid,integer)','execute') as server_monthly_callable,
             has_function_privilege('service_role','public.admin_set_shelly_user_server(uuid,uuid)','execute') as server_special_callable
    `);
    assert.deepEqual(acl, {old_shelly_callable:false,server_monthly_callable:true,server_special_callable:true});

    await db.query("select public.search_quota_authorize_special_user($1)", [special]);
    await db.exec("set role service_role");
    try {
      const {rows:[row]} = await db.query("select public.admin_set_shelly_user_server($1,$2) as result", [admin,special]);
      assert.deepEqual(row.result, {configured:true});
      await db.query("select public.admin_set_search_quota_limits_server($1,$2)", [admin,900]);
    } finally { await db.exec("reset role"); }

    await db.exec("set role authenticated");
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [special]);
      const {rows:[row]} = await db.query("select public.get_search_quota_status() as status");
      assert.equal(row.status.daily_limit, null);
      assert.equal(row.status.monthly_limit, 900);
    } finally { await db.exec("reset role"); }
  } finally { await db.close(); }
});
