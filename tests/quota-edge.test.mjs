import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";

test("Edge handler uses the verified owner and settles provider errors and cancellation", async t => {
  const url = "https://project.example";
  const user = randomUUID(), suppliedOwner = randomUUID(), requestId = randomUUID();
  const env = {SUPABASE_URL:url, SUPABASE_ANON_KEY:"test-public",
    SUPABASE_SERVICE_ROLE_KEY:"test-server", SEARCH_API_KEY:"test-provider"};
  const originalDeno = globalThis.Deno;
  const originalFetch = globalThis.fetch;
  let handler;
  globalThis.Deno = {env:{get:name => env[name]}, serve:callback => { handler = callback; }};
  try {
    await import("../backend/supabase/functions/leads-search/index.ts");
    for (const [scenario, expectedStatus, settlement] of [
      ["success", 200, "confirm"], ["http", 502, "refund"], ["bad-json", 502, "refund"],
      ["bad-result", 502, "refund"], ["timeout", 502, "refund"], ["cancel", 499, "refund"]
    ]) {
      await t.test(scenario, async () => {
        const abort = new AbortController();
        const calls = [], quotaArgs = [];
        globalThis.fetch = async (input, options) => {
          if (input === url + "/auth/v1/user") {
            assert.equal(options.headers.Authorization, "Bearer test-user");
            return Response.json({id:user});
          }
          if (input.startsWith(url + "/rest/v1/rpc/")) {
            const name = input.split("/").at(-1).split("_")[0];
            calls.push(name);
            assert.equal(options.headers.Authorization, "Bearer test-server");
            assert.equal(options.headers.apikey, "test-server");
            const args = JSON.parse(options.body);
            assert.equal(args.p_user_id, user);
            assert.equal(args.p_request_id, requestId);
            assert.match(args.p_attempt_id, /^[a-f0-9-]{36}$/);
            quotaArgs.push(args);
            assert.equal(options.signal.aborted, false);
            return Response.json(name === "reserve" ? {ok:true} :
              name === "refund" ? {refunded:true} : {confirmed:true});
          }
          if (input.startsWith(url + "/rest/v1/search_response_cache")) {
            return Response.json([]);
          }
          calls.push("provider");
          if (scenario === "http") return new Response("", {status:503});
          if (scenario === "bad-json") return new Response("{");
          if (scenario === "bad-result") return Response.json({results:[null]});
          if (scenario === "timeout") throw new DOMException("timeout", "TimeoutError");
          if (scenario === "cancel") {
            abort.abort();
            options.signal.throwIfAborted();
          }
          return Response.json({results:[]});
        };
        const response = await handler(new Request(url + "/functions/v1/leads-search", {
          method:"POST", headers:{Authorization:"Bearer test-user"}, signal:abort.signal,
          body:JSON.stringify({requestId, product:"mixer", p_user_id:suppliedOwner})
        }));
        assert.equal(response.status, expectedStatus);
        assert.deepEqual(calls, ["reserve", "provider", settlement]);
        assert.deepEqual(quotaArgs[0], quotaArgs[1]);
        const raw = await response.text();
        assert.doesNotMatch(raw, /test-server|test-user|p_attempt_id/);
        if (settlement === "refund") assert.equal(JSON.parse(raw).quotaRefunded, true);
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = originalDeno;
  }
});
