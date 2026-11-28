import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = path => readFile(resolve(root,path), "utf8");

test("public backend allowlist excludes identity-bearing migrations and scans every included file", async () => {
  const manifest = JSON.parse(await read("backend/deployment/public-backend-source-manifest.json"));
  assert.equal(manifest.status, "local review candidate; not published or deployed");
  assert.ok(manifest.files.length >= 10);
  assert.ok(manifest.excluded.includes("backend/supabase/migrations/20261127000300_search_quota_admin_edge_only.sql"));
  assert.ok(manifest.excluded.includes("backend/supabase/migrations/20261127000400_configure_shelly_quota_uuid.sql"));
  assert.ok(!manifest.files.some(path => /20261127000300_search_quota_admin_edge_only|20261127000400_configure_shelly_quota_uuid|quota-rollout|\.env/i.test(path)));

  for (const path of manifest.files) {
    const source = await read(path);
    assert.doesNotMatch(source, /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i, `${path} contains a UUID literal`);
    assert.doesNotMatch(source, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, `${path} contains an email address`);
    assert.doesNotMatch(source, /sb_secret_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{24,}/, `${path} contains a likely credential value`);
  }
});
