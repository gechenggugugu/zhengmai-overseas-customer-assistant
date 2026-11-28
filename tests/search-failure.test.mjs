import assert from "node:assert/strict";
import test from "node:test";

globalThis.ZHENGMAI_CONFIG = {searchEndpoint:"https://search.example.test"};
const {searchLeads,searchCompanyContacts} = await import("../services.mjs");
delete globalThis.ZHENGMAI_CONFIG;
const query = {mode:"live",product:"fixture"};
const lead = {sourceType:"live",name:"Fixture",website:"https://fixture.example.test"};

test("search failures show a trace and only claim a refund when confirmed", async t => {
  const originalFetch = globalThis.fetch;
  try {
    await t.test("confirmed refund has the request ID without raw error details", async () => {
      let sent;
      globalThis.fetch = async (_url,init) => {
        sent = JSON.parse(init.body).requestId;
        return Response.json({requestId:sent,code:"search_provider_timeout",quotaRefunded:true,message:"synthetic raw detail"},
          {status:502});
      };
      await assert.rejects(searchLeads(query), error => {
        assert.match(error.message,/响应超时/);
        assert.match(error.message,/额度已退回/);
        assert.ok(error.message.includes(sent));
        assert.doesNotMatch(error.message,/synthetic raw detail/);
        return true;
      });
    });
    await t.test("contact search can distinguish an unsettled quota", async () => {
      globalThis.fetch = async () => Response.json({quotaRefunded:false}, {status:503});
      await assert.rejects(searchCompanyContacts(lead), /额度结算尚未确认/);
    });
    await t.test("a missing endpoint does not claim a refund", async () => {
      globalThis.fetch = async () => Response.json({requestId:"not-a-request-id"},{status:404});
      await assert.rejects(searchLeads(query), error => {
        assert.match(error.message,/检查部署/);
        assert.match(error.message,/请求编号：[0-9a-f-]{36}/);
        assert.doesNotMatch(error.message,/not-a-request-id|额度已退回/);
        return true;
      });
    });
    await t.test("a transport failure cannot confirm settlement", async () => {
      globalThis.fetch = async () => { throw new TypeError("offline fixture"); };
      await assert.rejects(searchLeads(query), error => {
        assert.match(error.message,/未收到响应/);
        assert.match(error.message,/刷新额度/);
        assert.doesNotMatch(error.message,/offline fixture|额度已退回/);
        return true;
      });
    });
  } finally { globalThis.fetch = originalFetch; }
});
