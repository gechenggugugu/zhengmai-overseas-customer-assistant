import test from "node:test";
import assert from "node:assert/strict";
import {createCloudStore} from "../cloud-storage.mjs";

test("Supabase adapter signs in and scopes cloud upserts to the user", async () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
  let upsertBody;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes("/auth/v1/token?grant_type=password")) {
      return Response.json({access_token:"test-access", refresh_token:"test-refresh", expires_in:3600, user:{id:"user-a", email:"a@example.test"}});
    }
    if (String(url).includes("/rest/v1/lead_records")) {
      assert.equal(options.headers.Authorization, "Bearer test-access");
      if (options.method === "POST") { upsertBody = JSON.parse(options.body); return new Response(null, {status:204}); }
      return Response.json([]);
    }
    throw new Error("Unexpected URL " + url);
  };
  const store = createCloudStore({supabaseUrl:"https://project.example", supabaseAnonKey:"public-key"});
  const session = await store.signIn("a@example.test", "not-a-real-password");
  assert.equal(session.user.id, "user-a");
  await store.put("demo|buyer", {saved:true, status:"已联系"});
  assert.equal(upsertBody.owner_id, "user-a");
  assert.equal(upsertBody.record_key, "demo|buyer");
  assert.equal(await store.accessToken(), "test-access");
});
