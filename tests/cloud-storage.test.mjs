import test from "node:test";
import assert from "node:assert/strict";
import {createCloudStore} from "../cloud-storage.mjs";

test("Supabase SDK uses PKCE and sessionStorage; account data is upserted by authenticated user", async () => {
  globalThis.sessionStorage = {getItem(){return null},setItem(){},removeItem(){}};
  let options, upsertData, upsertOptions, listFilter, upserts = 0;
  const user = {id:"user-a", email:"a@example.test"};
  const chain = {select(){return this},maybeSingle:async()=>({data:{updated_at:"2026-11-26T00:00:00Z"},error:null})};
  const client = {
    auth:{
      signInWithPassword:async()=>({data:{session:{user,access_token:"test"}},error:null}),
      getSession:async()=>({data:{session:{user,access_token:"test"}},error:null}),
      getUser:async()=>({data:{user},error:null}),
      signUp:async()=>({data:{session:null},error:null}), signOut:async()=>({data:{},error:null})
    },
    from(){return {upsert(data,opts){upsertData=data; upsertOptions=opts; upserts++; return chain},select(){return this},
      eq(column,value){listFilter=[column,value]; return this},order(){return this},limit:async()=>({data:[],error:null})}}
  };
  const store = createCloudStore({supabaseUrl:"https://project.example",supabaseAnonKey:"publishable"},{createClient(_url,_key,opts){options=opts;return client}});
  const session = await store.signIn("a@example.test","not-a-real-password");
  assert.equal(session.user.id,"user-a");
  assert.equal(options.auth.flowType,"pkce");
  assert.equal(options.auth.storage,globalThis.sessionStorage);
  await store.list("user-a");
  assert.deepEqual(listFilter, ["owner_id","user-a"]);
  await store.put("lead|domain",{saved:true},"user-a");
  assert.equal(upsertData.owner_id,"user-a");
  assert.equal(upsertData.record_key,"lead|domain");
  assert.equal(upsertOptions.ignoreDuplicates,true);
  await assert.rejects(store.put("lead|domain",{saved:true},"user-b"), /登录账号已变更/);
  assert.equal(upserts,1);
});

test("Supabase adapter remains disabled without project configuration", () => {
  assert.equal(createCloudStore({},{}).isConfigured(),false);
});

function makePageStore(records, {serverLimit = 1000, repeatPage = false} = {}) {
  const requests = [];
  const client = {
    from(table) {
      const request = {table};
      requests.push(request);
      return {
        select(){return this},
        eq(column,value){request.scope=[column,value]; return this},
        order(column,options){request.sort=[column,options.ascending]; return this},
        limit(value){request.limit=value; return this},
        gt(column,value){request.cursor=[column,value]; return this},
        then(resolve){
          const after = repeatPage ? null : request.cursor?.[1];
          const rows = records.filter(row => after == null || row.record_key > after)
            .slice(0,Math.min(serverLimit,request.limit));
          resolve({data:rows,error:null});
        }
      };
    }
  };
  const store = createCloudStore({supabaseUrl:"https://project.example",supabaseAnonKey:"publishable"},
    {createClient:() => client});
  return {store,requests};
}

test("cloud sync reads over 1000 records even when the server shortens every page", async () => {
  const updatedAt = "2026-11-28T12:00:00Z";
  const rows = Array.from({length:1103}, (_, index) => ({
    record_key:String(index).padStart(4,"0"), record:{saved:true,updatedAt:"old"}, updated_at:updatedAt
  }));
  const {store,requests} = makePageStore(rows,{serverLimit:73});
  const actual = await store.list("user-a");
  assert.deepEqual(actual.map(row => row.record_key), rows.map(row => row.record_key));
  assert.ok(actual.every(row => row.record.updatedAt === updatedAt));
  assert.ok(requests.length > 15);
  for (const request of requests) {
    assert.deepEqual(request.scope,["owner_id","user-a"]);
    assert.deepEqual(request.sort,["record_key",true]);
    if (request.cursor) assert.equal(request.cursor[0],"record_key");
  }
});

test("a repeated cloud page fails instead of looping or returning partial records", async () => {
  const {store,requests} = makePageStore([{record_key:"1",record:{saved:true}}],{repeatPage:true});
  await assert.rejects(store.list("user-a"), /云端记录分页异常/);
  assert.equal(requests.length,2);
});

test("a stale edit uses an exact server revision and reads the winning row without upserting", async () => {
  const oldRevision = "2026-11-28T12:00:00.123456+00:00";
  const remoteRevision = "2026-11-28T12:10:00.987654+00:00";
  const requests = [];
  const client = {
    auth:{getUser:async()=>({data:{user:{id:"user-a"}},error:null})},
    from() {
      const request = {filters:[]};
      return {
        update(payload){request.body=payload; return this},
        eq(key,value){request.filters.push([key,value]); return this},
        select(){return this},
        async maybeSingle(){
          requests.push(request);
          return {data:request.body ? null : {
            record_key:"live|lead.example",updated_at:remoteRevision,record:{note:"updated by second device"}
          },error:null};
        }
      };
    }
  };
  const store = createCloudStore({supabaseUrl:"https://project.example",supabaseAnonKey:"publishable"},
    {createClient:() => client});
  const result = await store.put("live|lead.example",{
    note:"offline edit",syncRevision:oldRevision,pendingSync:true,localConflict:{note:"previous edit"}
  },"user-a");
  assert.deepEqual(requests[0],{
    body:{record:{note:"offline edit"}},
    filters:[["owner_id","user-a"],["record_key","live|lead.example"],["updated_at",oldRevision]]
  });
  assert.deepEqual(requests[1].filters,[["owner_id","user-a"],["record_key","live|lead.example"]]);
  assert.equal(result.conflictRecord.note,"updated by second device");
  assert.equal(result.conflictRecord.syncRevision,remoteRevision);
});
