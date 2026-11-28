import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import test from "node:test";
const engine = process.env.QUOTA_TEST_PGLITE_PATH;
const migrations = new URL("../backend/supabase/migrations/", import.meta.url);
const candidate = new URL("../backend/deployment/staging-quota/candidate-migrations/20261128190000_special_quota_authorization_registry.sql", import.meta.url);

test("candidate identity registry preserves approved synthetic binding and supports owner-only authorization/revocation", {skip: !engine}, async () => {
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
    const normal = randomUUID(), admin = randomUUID(), special = randomUUID(), approvedLater = randomUUID(), unlisted = randomUUID();
    await db.query(`
      insert into auth.users(id,raw_app_meta_data) values
        ($1,'{}'),($2,'{"role":"admin"}'),($3,'{}'),($4,'{}'),($5,'{}')
    `, [normal, admin, special, approvedLater, unlisted]);
    await db.query(`insert into public.search_quota_special_users(slot,user_id,created_by,created_at)
                    values ('shelly',$1,$2,clock_timestamp())`, [special, admin]);
    await db.exec(await readFile(candidate, "utf8"));

    const status = async userId => {
      await db.exec("set role authenticated");
      try {
        await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
        const {rows:[row]} = await db.query("select public.get_search_quota_status() as status");
        return row.status;
      } finally { await db.exec("reset role"); }
    };
    const setSpecial = async userId => {
      await db.exec("set role service_role");
      try {
        const {rows:[row]} = await db.query(
          "select public.admin_set_shelly_user_server($1,$2) as result", [admin,userId]);
        return row.result;
      } finally { await db.exec("reset role"); }
    };

    assert.deepEqual((await db.query(`
      select count(*)::int as n from public.search_quota_authorized_users where user_id=$1
    `,[special])).rows[0], {n:1});
    assert.equal((await status(special)).daily_limit, null);
    assert.equal((await status(normal)).daily_limit, 5);
    await assert.rejects(setSpecial(unlisted), /special_user_not_authorized/);

    await db.query("select public.search_quota_authorize_special_user($1)", [approvedLater]);
    assert.deepEqual(await setSpecial(approvedLater), {configured:true});
    const specialStatus = await status(approvedLater);
    assert.equal(specialStatus.daily_limit, null);
    assert.equal(specialStatus.monthly_limit, 1000);

    await db.exec("set role service_role");
    let reservation;
    try {
      const {rows:[row]} = await db.query(
        "select public.reserve_search_quota($1,$2,$3) as result", [randomUUID(),approvedLater,randomUUID()]);
      reservation = row.result;
    } finally { await db.exec("reset role"); }
    assert.equal(reservation.ok, true);
    assert.equal(reservation.daily_unlimited, true);

    const revoked = await db.query("select public.search_quota_revoke_special_user_authorization($1) as result", [approvedLater]);
    assert.equal(revoked.rows[0].result.authorized, false);
    assert.equal((await status(approvedLater)).daily_limit, 5);
    await db.query("select public.search_quota_authorize_special_user($1)", [approvedLater]);
    assert.equal((await status(approvedLater)).daily_limit, null);

    const {rows:[acl]} = await db.query(`
      select has_table_privilege('anon','public.search_quota_authorized_users','select') as anon_read,
             has_table_privilege('authenticated','public.search_quota_authorized_users','select') as user_read,
             has_table_privilege('service_role','public.search_quota_authorized_users','insert') as service_insert,
             has_function_privilege('service_role','public.search_quota_authorize_special_user(uuid)','execute') as service_can_authorize,
             has_function_privilege('authenticated','public.search_quota_revoke_special_user_authorization(uuid)','execute') as user_can_revoke
    `);
    assert.deepEqual(acl, {anon_read:false,user_read:false,service_insert:false,service_can_authorize:false,user_can_revoke:false});
  } finally { await db.close(); }
});
