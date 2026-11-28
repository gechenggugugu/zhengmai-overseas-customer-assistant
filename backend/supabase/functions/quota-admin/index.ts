const corsHeaders = (origin: string | null, allowed: string[]) => ({
  "Access-Control-Allow-Origin": origin && allowed.includes(origin) ? origin : "null",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin"
});

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {status, headers:{...cors,
    "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"}});
}

const allowedOrigins = [...new Set([
  "http://127.0.0.1:4173",
  ...(Deno.env.get("APP_ORIGINS") || "").split(",").map(value => value.trim()).filter(Boolean)
])];

async function callAdminRpc(name: string, args: Record<string, unknown>) {
  const url = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("server_configuration_missing");
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {method:"POST",
    headers:{apikey:key, Authorization:`Bearer ${key}`, "Content-Type":"application/json"},
    body:JSON.stringify(args), signal:AbortSignal.timeout(8_000), redirect:"error"});
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const code = typeof payload?.message === "string" ? payload.message : "admin_operation_failed";
    throw Object.assign(new Error("admin_operation_failed"), {code, status:response.status});
  }
  return response.json();
}

Deno.serve(async request => {
  const origin = request.headers.get("Origin");
  const cors = corsHeaders(origin, allowedOrigins);
  if (origin && !allowedOrigins.includes(origin)) return json({error:"origin_not_allowed"}, 403, cors);
  if (request.method === "OPTIONS") return new Response(null, {status:204, headers:cors});
  if (request.method !== "POST") return json({error:"method_not_allowed"}, 405, cors);

  const bearer = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  const url = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!bearer || !url || !publicKey) return json({error:"authentication_required"}, 401, cors);
  const identity = await fetch(`${url}/auth/v1/user`, {headers:{apikey:publicKey, Authorization:`Bearer ${bearer}`},
    signal:AbortSignal.timeout(8_000)}).catch(() => null);
  if (!identity?.ok) return json({error:"invalid_session"}, 401, cors);
  const user = await identity.json().catch(() => null);
  const userId = user?.id;
  if (typeof userId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(userId)) {
    return json({error:"invalid_session"}, 401, cors);
  }
  if (user?.app_metadata?.role !== "admin") return json({error:"admin_required"}, 403, cors);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch { return json({error:"invalid_json"}, 400, cors); }
  try {
    if (body.action === "set_monthly_limit" && Number.isInteger(body.monthlyLimit)) {
      const result = await callAdminRpc("admin_set_search_quota_limits_server", {
        p_admin_user_id:userId, p_monthly_limit:body.monthlyLimit
      });
      return json({ok:true, result}, 200, cors);
    }
    return json({error:"invalid_admin_action"}, 400, cors);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "admin_operation_failed";
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
    return json({error:code === "shelly_auth_user_mismatch" ? code :
      code === "admin_required" ? code : "admin_operation_failed"}, status >= 400 && status < 500 ? status : 500, cors);
  }
});
