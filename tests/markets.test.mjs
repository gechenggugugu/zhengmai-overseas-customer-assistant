import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const markets = JSON.parse(await readFile(new URL("../backend/supabase/functions/_shared/markets.json", import.meta.url), "utf8"));
const edge = await readFile(new URL("../backend/supabase/functions/leads-search/index.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../app.mjs", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("shared ISO market data contains all 249 ISO 3166-1 entries with Chinese and English names", () => {
  assert.equal(markets.length, 249);
  assert.equal(new Set(markets.map(market => market.code)).size, markets.length);
  assert.ok(markets.every(market => /^[A-Z]{2}$/.test(market.code) && market.zh && market.en && typeof market.tavily === "boolean" && typeof market.brave === "boolean"));
  for (const code of ["MY", "AE", "AU", "VN", "SA"]) assert.ok(markets.some(market => market.code === code));
});

test("country search uses one shared market config for searchable list and quick picks", () => {
  assert.match(html, /id="market-search"/);
  assert.match(html, /id="market-list" name="market"/);
  for (const code of ["MY", "AE", "AU", "VN", "SA"]) assert.match(html, new RegExp(`data-market="${code}"`));
  assert.match(app, /fetch\("\.\/backend\/supabase\/functions\/_shared\/markets\.json"/);
  assert.match(app, /market\.code, market\.zh, market\.en, \.\.\.\(market\.aliases \|\| \[\]\)/);
  assert.ok(markets.find(market => market.code === "AE").aliases.includes("阿联酋"));
  assert.match(app, /全部市场（全球搜索）/);
});

test("search resolves ISO codes and legacy labels, sends Tavily English country names, and maps Brave ISO codes", () => {
  assert.match(edge, /import marketData from "\.\.\/_shared\/markets\.json"/);
  assert.match(edge, /const requestedMarket = marketFor\(query\.market\)/);
  assert.match(edge, /\["uae", "阿联酋"\]/);
  assert.match(edge, /query\.market = requestedMarket\?\.code/);
  assert.match(edge, /country:selectedMarket\?\.tavily \? selectedMarket\.en\.toLocaleLowerCase\(\) : null/);
  assert.match(edge, /if \(selectedMarket\?\.brave\) url\.searchParams\.set\("country", selectedMarket\.code\)/);
  for (const market of markets.filter(market => ["MY", "AE", "AU", "VN", "SA"].includes(market.code))) {
    assert.ok(market.tavily, `${market.code} should be accepted by Tavily country targeting`);
  }
  for (const code of ["US", "MY", "AE", "AU", "VN", "SA", "GB", "DE", "FR", "JP", "CA"]) {
    assert.ok(markets.find(market => market.code === code).brave, `${code} preserves existing Brave targeting`);
  }
});

test("country-specific query expands business terms while global search stays unscoped", () => {
  assert.match(edge, /distributor importer dealer wholesaler supplier/);
  assert.match(edge, /if \(query\.market && !requestedMarket\) return json\(\{error:"invalid_market"\}/);
  assert.match(edge, /replace\(\/\^www\\\.\//);
  assert.match(edge, /const market = requestedMarket && aliases\.some/);
});
