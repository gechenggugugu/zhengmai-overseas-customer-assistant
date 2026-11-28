import test from "node:test";
import assert from "node:assert/strict";
import {draftEmail, leadKey, repository, safeUrl, searchLeads, uniqueLeads, csvEncode} from "../services.mjs";

const query = {product:"商用烤箱", market:"马来西亚", type:"设备经销商", keyword:"bakery equipment", days:"30", mode:"demo"};

test("demo search applies filters and labels sample data", async () => {
  const leads = await searchLeads(query);
  assert.equal(leads.length, 2);
  assert.ok(leads.every(lead => lead.sourceType === "demo"));
  assert.ok(leads.every(lead => lead.website.endsWith(".example")));
});

test("duplicate sample results collapse by normalized website", async () => {
  const leads = await searchLeads({...query, market:"", type:"", days:"", keyword:""});
  const unique = uniqueLeads(leads);
  assert.equal(leads.length - unique.length, 1);
  assert.equal(leads.filter(lead => lead.name === "Atlas Bakery Supply").length, 2);
  assert.equal(leadKey(leads[0]), leadKey(leads.at(-1)));
});

test("live results from different target markets deduplicate www and bare hostnames", () => {
  const results = [
    {name:"Regional Bakery Supply", market:"马来西亚", sourceType:"live", website:"https://www.regional-bakery.example"},
    {name:"Regional Bakery Supply", market:"新加坡", sourceType:"live", website:"https://regional-bakery.example"}
  ];
  assert.equal(uniqueLeads(results).length, 1);
  assert.equal(leadKey(results[0]), leadKey(results[1]));
});

test("live search fails clearly until a backend URL is configured", async () => {
  await assert.rejects(searchLeads({...query, mode:"live"}), /真实搜索尚未配置/);
});

test("unsafe links are rejected and demo email clearly says fictional", () => {
  assert.equal(safeUrl("javascript:alert(1)"), "");
  const email = draftEmail({name:"Example Buyer", sourceType:"demo"}, "商用烤箱");
  assert.match(email, /演示草稿 · 虚构客户/);
  assert.match(email, /Subject: Zhengmai bakery equipment/);
});

test("CSV quotes cells and neutralizes spreadsheet formulas", () => {
  const csv = csvEncode([["name", "note"], ["O\"Brien", "=HYPERLINK(\"https://x\")"]]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /"O""Brien"/);
  assert.match(csv, /"'=HYPERLINK/);
});

test("repository keeps favorites and follow-up history in browser storage", () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); }
  };
  const lead = {name:"Persist Test", market:"测试", sourceType:"demo", website:"https://persist.example"};
  repository.put(lead, {saved:true, status:"已联系", note:"已发送目录"});
  const record = repository.list()[leadKey(lead)];
  assert.equal(record.saved, true);
  assert.equal(record.status, "已联系");
  assert.equal(record.history.length, 1);
});

test("cloud namespaces keep different users' cached records separate", () => {
  const lead = {name:"Account Scoped", market:"测试", sourceType:"demo", website:"https://scoped.example"};
  repository.useUser("user-a");
  repository.put(lead, {saved:true});
  repository.useUser("user-b");
  assert.equal(Object.keys(repository.list()).length, 0);
  repository.useUser("user-a");
  assert.equal(Object.values(repository.list())[0].saved, true);
  repository.useUser(null);
});

test("cloud sync imports remote records and uploads newer local changes", async () => {
  const remote = new Map();
  const uploaded = [];
  const cloud = {
    async list() { return [...remote].map(([record_key, record]) => ({record_key, record})); },
    async put(key, record) { remote.set(key, structuredClone(record)); uploaded.push(key); }
  };
  repository.setCloudAdapter(cloud);
  repository.useUser("sync-user");
  const remoteLead = {name:"Remote Buyer", market:"测试", sourceType:"live", website:"https://remote.example"};
  const remoteKey = leadKey(remoteLead);
  remote.set(remoteKey, {lead:remoteLead, saved:true, status:"已联系", note:"云端备注", history:[], updatedAt:"2026-11-25T00:00:00.000Z"});
  await repository.syncCloud();
  assert.equal(repository.list()[remoteKey].note, "云端备注");
  const localLead = {name:"Local Buyer", market:"测试", sourceType:"demo", website:"https://local-sync.example"};
  repository.put(localLead, {saved:true, status:"已回复"});
  await repository.syncCloud();
  assert.ok(uploaded.includes(leadKey(localLead)));
  assert.equal(remote.get(leadKey(localLead)).status, "已回复");
  repository.useUser(null);
  repository.setCloudAdapter(null);
});

test("guest data is copied only into the selected account and remains available locally", async () => {
  const values = new Map();
  globalThis.localStorage = {getItem:key=>values.get(key) ?? null, setItem:(key,value)=>values.set(key,value)};
  const guestLead = {name:"Guest Lead", market:"测试", sourceType:"demo", website:"https://guest-import.example"};
  repository.useUser(null);
  repository.put(guestLead,{saved:true,note:"local"});
  const uploaded=[];
  repository.setCloudAdapter({async list(){return []},async put(key,record){uploaded.push([key,record]);return {updated_at:record.updatedAt}}});
  repository.useUser("chosen-user");
  assert.equal(await repository.importGuestRecords(),1);
  assert.equal(repository.list()[leadKey(guestLead)].note,"local");
  assert.equal(uploaded.length,1);
  assert.equal(Object.keys(repository.guestRecords()).length,1);
  repository.useUser(null); repository.setCloudAdapter(null);
});

test("a pending pull from the old account cannot upload or populate the new account", async () => {
  let finishPull;
  const writes = [];
  const lead = {name:"Old account fixture", website:"https://old-account.example"};
  repository.useUser("switch-from");
  repository.put(lead,{saved:true});
  repository.setCloudAdapter({
    list:owner => { assert.equal(owner,"switch-from"); return new Promise(resolve => { finishPull=resolve; }); },
    put:(key,record,owner) => writes.push({key,record,owner})
  });
  try {
    const pending = repository.syncCloud();
    repository.useUser("switch-to");
    finishPull([{record_key:leadKey(lead),record:{lead,saved:true,updatedAt:"2026-12-01T00:00:00Z"}}]);
    assert.equal(await pending,false);
    assert.deepEqual(repository.list(),{});
    assert.deepEqual(writes,[]);
  } finally { repository.useUser(null); repository.setCloudAdapter(null); }
});

test("serializing same-record edits keeps the newest edit after a delayed save", async () => {
  let completeFirst, firstStarted;
  const started = new Promise(resolve => { firstStarted=resolve; });
  const writes = [];
  const revisions = [];
  const lead = {name:"Edit fixture", website:"https://edit-race.example"};
  repository.useUser("edit-race");
  repository.setCloudAdapter({
    put:async (_key,record,owner) => {
      assert.equal(owner,"edit-race");
      writes.push(record.note);
      revisions.push(record.syncRevision);
      if (writes.length === 1) {
        await new Promise(resolve => { completeFirst=resolve; firstStarted(); });
        return {updated_at:"2099-01-01T00:00:00Z"};
      }
      return {updated_at:record.updatedAt};
    }
  });
  try {
    repository.put(lead,{note:"first edit"});
    const first = repository.syncRecord(lead);
    await started;
    repository.put(lead,{note:"newest edit"});
    const second = repository.syncRecord(lead);
    assert.deepEqual(writes,["first edit"]);
    completeFirst();
    assert.deepEqual(await Promise.all([first,second]),[true,true]);
    const saved = repository.list()[leadKey(lead)];
    assert.equal(saved.note,"newest edit");
    assert.notEqual(saved.updatedAt,"2099-01-01T00:00:00Z");
    assert.deepEqual(writes,["first edit","newest edit"]);
    assert.equal(revisions[1],"2099-01-01T00:00:00Z");
  } finally { repository.useUser(null); repository.setCloudAdapter(null); }
});

test("an offline edit conflict keeps the current cloud record and a local recovery copy", async () => {
  const lead = {name:"Conflict fixture", website:"https://conflict.example"};
  const key = leadKey(lead);
  const previous = "2026-11-28T01:00:00Z";
  const current = "2026-11-28T23:00:00Z";
  let cloudRecord = {lead,note:"original",history:[],status:"待联系",updatedAt:previous,syncRevision:previous};
  let attempts = 0;
  repository.useUser("conflict-test");
  repository.setCloudAdapter({
    async list(){return [{record_key:key,record:cloudRecord}]},
    async put(_key, record){
      attempts++;
      assert.equal(record.syncRevision,previous);
      return {conflictRecord:cloudRecord};
    }
  });
  try {
    await repository.syncCloud();
    repository.put(lead,{note:"offline follow-up",status:"已联系"});
    cloudRecord = {...cloudRecord,note:"newer cloud follow-up",updatedAt:current,syncRevision:current};
    await assert.rejects(repository.syncCloud(),{code:"CLOUD_EDIT_CONFLICT"});
    assert.equal(repository.list()[key].note,"newer cloud follow-up");
    assert.equal(repository.list()[key].localConflict.note,"offline follow-up");
    assert.equal(repository.list()[key].localConflict.status,"已联系");
    await repository.syncCloud();
    assert.equal(repository.list()[key].localConflict.note,"offline follow-up");
    assert.equal(attempts,1);
  } finally { repository.useUser(null); repository.setCloudAdapter(null); }
});
