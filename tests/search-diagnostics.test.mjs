import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {classifySearchFailure, logSearchFailure} from "../backend/supabase/functions/leads-search/diagnostics.mjs";

const fn = await readFile(new URL("../backend/supabase/functions/leads-search/index.ts", import.meta.url), "utf8");

test("provider timeout has a stable safe diagnostic", () => {
  assert.equal(classifySearchFailure(Object.assign(new Error("secret"), {name:"TimeoutError"})).code, "search_provider_timeout");
});

test("provider non-2xx is distinguishable without exposing response details", () => {
  const result = classifySearchFailure(Object.assign(new Error("private response"), {code:"PROVIDER_HTTP_ERROR", status:429}));
  assert.equal(result.code, "search_provider_http_error");
  assert.doesNotMatch(result.message, /private|429/);
});

test("provider JSON parse errors are diagnosed", () => {
  assert.equal(classifySearchFailure(new SyntaxError("sensitive body")).code, "search_provider_invalid_json");
});

test("invalid provider result shape gets a stable diagnostic", () => {
  const result = classifySearchFailure(Object.assign(new Error(), {code:"PROVIDER_INVALID_RESPONSE"}));
  assert.equal(result.code, "search_provider_invalid_response");
});

test("missing configuration has a safe actionable error", () => {
  const result = classifySearchFailure(Object.assign(new Error(), {code:"SEARCH_CONFIG_MISSING"}));
  assert.equal(result.code, "search_provider_not_configured");
  assert.match(result.message, /联系管理员/);
});

test("unknown exceptions stay generic and logs omit secrets and exception messages", () => {
  let line = "";
  const result = logSearchFailure({requestId:"req-test", stage:"provider_fetch_and_parse", provider:"tavily",
    error:new Error("Bearer super-secret private customer"), log:value => { line = value; }});
  assert.equal(result.code, "search_internal_error");
  assert.match(line, /req-test/);
  assert.doesNotMatch(line, /super-secret|private customer|Bearer/);
});

test("Edge Function returns diagnostic fields and logs provider failures", () => {
  assert.match(fn, /logSearchFailure\(\{requestId, stage, provider, error\}\)/);
  assert.match(fn, /code:diagnostic\.code, message:diagnostic\.message, requestId/);
  assert.match(fn, /response\.json\(\)/);
  assert.match(fn, /PROVIDER_HTTP_ERROR/);
});
