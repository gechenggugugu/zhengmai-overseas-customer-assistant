import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";

test("quota-admin verifies Auth identity and routes admin RPCs through service credentials", async t => {
  const url = "https://project.example";
  const admin = randomUUID(), user = randomUUID();
  const env = {SUPABASE_URL:url, SUPABASE_ANON_KEY:"test-public", SUPABASE_SERVICE_ROLE_KEY:"test-server"};
  const originalDeno = globalThis.Deno;
  const originalFetch = globalThis.fetch;
  let handler;
  globalThis.Deno = {env:{get:name => env[name]}, serve:callback => { handler = callback; }};
  try {
    await import("../backend/supabase/functions/quota-admin/index.ts");
    await t.test("browser SDK preflight permits x-client-info only for allowed origins", async () => {
      for (const [origin, status] of [
        ["http://127.0.0.1:4173", 204],
        ["https://unlisted.example", 403]
      ]) {
        const response = await handler(new Request(`${url}/functions/v1/quota-admin`, {
          method:"OPTIONS",
          headers:{Origin:origin, "Access-Control-Request-Method":"POST",
            "Access-Control-Request-Headers":"authorization, apikey, content-type, x-client-info"}
        }));
        assert.equal(response.status, status);
        assert.equal(response.headers.get("Access-Control-Allow-Origin"), status === 204 ? origin : "null");
        if (status === 204) {
          const allowed = response.headers.get("Access-Control-Allow-Headers").split(",").map(x => x.trim());
          assert.ok(allowed.includes("x-client-info"));
        }
      }
    });
    for (const scenario of ["monthly", "unsupported-identity-action", "not-admin", "invalid-session"]) {
      await t.test(scenario, async () => {
        const calls = [];
        globalThis.fetch = async (input, options) => {
          if (input === `${url}/auth/v1/user`) {
            assert.equal(options.headers.Authorization, "Bearer test-user");
            if (scenario === "invalid-session") return new Response("", {status:401});
            return Response.json({id:scenario === "not-admin" ? user : admin,
              app_metadata:scenario === "not-admin" ? {} : {role:"admin"}});
          }
          assert.equal(options.headers.apikey, "test-server");
          assert.equal(options.headers.Authorization, "Bearer test-server");
          const name = input.split("/").at(-1);
          calls.push({name, args:JSON.parse(options.body)});
          return Response.json({monthly_limit:1000, configured:true});
        };
        const body = scenario === "monthly" ? {action:"set_monthly_limit", monthlyLimit:1000} :
          scenario === "unsupported-identity-action" ? {action:"set_shelly_user", userId:randomUUID()} : {action:"unknown"};
        const response = await handler(new Request(`${url}/functions/v1/quota-admin`, {
          method:"POST", headers:{Authorization:"Bearer test-user", "Content-Type":"application/json"}, body:JSON.stringify(body)
        }));
        assert.equal(response.status, scenario === "invalid-session" ? 401 : scenario === "not-admin" ? 403 :
          scenario === "unsupported-identity-action" ? 400 : 200);
        if (scenario === "monthly") {
          assert.deepEqual(calls[0], {name:"admin_set_search_quota_limits_server",
            args:{p_admin_user_id:admin,p_monthly_limit:1000}});
        } else assert.equal(calls.length, 0);
        assert.doesNotMatch(await response.text(), /test-server|test-user/);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = originalDeno;
  }
});
