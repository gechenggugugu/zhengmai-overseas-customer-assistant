// Uses the official Supabase JS SDK loaded by index.html. Auth tokens are kept
// in sessionStorage with PKCE; this reduces persistence but does not mitigate XSS.
const RECORD_PAGE_SIZE = 250;
const RECORD_FIELDS = "record_key,record,updated_at";
function fromCloudRow(row) {
  const {syncRevision,pendingSync,localConflict,...record} = row.record || {};
  return {...record, updatedAt:row.updated_at, syncRevision:row.updated_at};
}

export function createCloudStore(config, sdk = globalThis.supabase) {
  const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey && sdk?.createClient);
  const client = configured ? sdk.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth:{flowType:"pkce", storage:globalThis.sessionStorage, persistSession:true,
      autoRefreshToken:true, detectSessionInUrl:true}
  }) : null;
  const unwrap = ({data, error}) => { if (error) throw new Error(error.message || "云端请求失败"); return data; };
  return {
    isConfigured:() => configured,
    restoreSession:async () => unwrap(await client.auth.getSession())?.session || null,
    accessToken:async () => (await client.auth.getSession()).data?.session?.access_token || "",
    getQuotaStatus:async () => unwrap(await client.rpc("get_search_quota_status")),
    setQuotaLimits:async monthlyLimit => {
      const result = unwrap(await client.functions.invoke("quota-admin", {body:{action:"set_monthly_limit", monthlyLimit}}));
      return result?.result;
    },
    setShellyUser:async userId => {
      const result = unwrap(await client.functions.invoke("quota-admin", {body:{action:"set_shelly_user", userId:userId || null}}));
      return result?.result;
    },
    onAuthStateChange:callback => client.auth.onAuthStateChange((_event, session) => callback(session)),
    signIn:async (email, password) => unwrap(await client.auth.signInWithPassword({email:String(email).trim().toLowerCase(), password})).session,
    signUp:async (email, password) => {
      const result = unwrap(await client.auth.signUp({email, password, options:{emailRedirectTo:location.origin + location.pathname}}));
      return result.session;
    },
    signOut:async () => unwrap(await client.auth.signOut()),
    list:async ownerId => {
      if (!ownerId) throw new Error("请重新登录云端账号。");
      const records = [];
      const seenKeys = new Set();
      let after = null;
      while (true) {
        let page = client.from("lead_records").select(RECORD_FIELDS)
          .eq("owner_id", ownerId).order("record_key", {ascending:true}).limit(RECORD_PAGE_SIZE);
        if (after !== null) page = page.gt("record_key", after);
        const rows = unwrap(await page);
        if (!Array.isArray(rows)) throw new Error("云端记录格式无效。");
        // A lower server limit may produce short pages before the end.
        if (rows.length === 0) return records;
        for (const row of rows) {
          if (typeof row?.record_key !== "string" || !row.record_key || seenKeys.has(row.record_key)) {
            throw new Error("云端记录分页异常，请稍后重试。");
          }
          seenKeys.add(row.record_key);
          records.push({...row, record:fromCloudRow(row)});
        }
        after = rows.at(-1).record_key;
      }
    },
    put:async (recordKey, record, ownerId) => {
      const {data:{user}, error:userError} = await client.auth.getUser();
      if (userError || !user || user.id !== ownerId) throw new Error("登录账号已变更，请重新同步。");
      const {syncRevision,pendingSync,localConflict,...payload} = record;
      const table = () => client.from("lead_records");
      const forRecord = query => query.eq("owner_id",ownerId).eq("record_key",recordKey);
      let saved = null;
      if (syncRevision || Number.isFinite(Date.parse(record.updatedAt))) {
        const update = forRecord(table().update({record:payload}));
        const guarded = syncRevision ? update.eq("updated_at",syncRevision) : update.lt("updated_at",record.updatedAt);
        saved = unwrap(await guarded.select(RECORD_FIELDS).maybeSingle());
      }
      if (!saved && !syncRevision) {
        saved = unwrap(await table().upsert({owner_id:ownerId,record_key:recordKey,record:payload},
          {onConflict:"owner_id,record_key",ignoreDuplicates:true}).select(RECORD_FIELDS).maybeSingle());
      }
      if (saved) return saved;
      const latest = unwrap(await forRecord(table().select(RECORD_FIELDS)).maybeSingle());
      if (!latest) throw new Error("云端记录已变更，请重新同步。");
      return {conflictRecord:fromCloudRow(latest)};
    }
  };
}
