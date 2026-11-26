const SESSION_KEY = "zhengmai.auth.session.v1";

export function createCloudStore(config) {
  let session = null;
  const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const apiHeaders = extra => ({apikey:config.supabaseAnonKey, "Content-Type":"application/json", ...extra});

  function saveSession(value) {
    session = value?.access_token ? {
      access_token:value.access_token,
      refresh_token:value.refresh_token,
      expires_at:Date.now() + Number(value.expires_in || 3600) * 1000,
      user:value.user || session?.user
    } : null;
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
    return session;
  }

  async function auth(path, payload) {
    const response = await fetch(config.supabaseUrl + "/auth/v1/" + path, {
      method:"POST", headers:apiHeaders(), body:JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.msg || result.message || result.error_description || "云端账号请求失败");
    return result;
  }

  async function currentSession() {
    if (!configured) return null;
    if (!session) {
      try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); }
      catch { session = null; }
    }
    if (!session) return null;
    if (session.expires_at - Date.now() < 60_000) {
      try { saveSession(await auth("token?grant_type=refresh_token", {refresh_token:session.refresh_token})); }
      catch { saveSession(null); }
    }
    return session;
  }

  async function dataRequest(path, options = {}) {
    const active = await currentSession();
    if (!active) throw new Error("请先登录云端账号。");
    const response = await fetch(config.supabaseUrl + "/rest/v1/" + path, {
      ...options,
      headers:apiHeaders({Authorization:"Bearer " + active.access_token, ...(options.headers || {})})
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.message || "云端同步失败（" + response.status + "）");
    }
    return response.status === 204 ? null : response.json();
  }

  return {
    isConfigured:() => configured,
    restoreSession:currentSession,
    accessToken:async () => (await currentSession())?.access_token || "",
    signIn:async (email, password) => saveSession(await auth("token?grant_type=password", {email, password})),
    signUp:async (email, password) => {
      const result = await auth("signup", {email, password});
      if (result.access_token) return saveSession(result);
      return null;
    },
    signOut:async () => {
      const active = await currentSession();
      try {
        if (active) await fetch(config.supabaseUrl + "/auth/v1/logout", {
          method:"POST", headers:apiHeaders({Authorization:"Bearer " + active.access_token})
        });
      } finally { saveSession(null); }
    },
    list:async () => (await dataRequest("lead_records?select=record_key,record,updated_at&order=updated_at.asc"))
      .map(row => ({...row, record:{...row.record, updatedAt:row.updated_at}})),
    put:(recordKey, record) => currentSession().then(active => dataRequest(
      "lead_records?on_conflict=owner_id%2Crecord_key",
      {method:"POST", headers:{Prefer:"resolution=merge-duplicates,return=representation"},
        body:JSON.stringify({owner_id:active.user.id, record_key:recordKey, record, updated_at:record.updatedAt || new Date().toISOString()})}
    )).then(rows => Array.isArray(rows) ? rows[0] : null)
  };
}
