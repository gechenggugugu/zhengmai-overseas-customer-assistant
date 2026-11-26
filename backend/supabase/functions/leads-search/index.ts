const corsHeaders = (origin: string | null, allowed: string[]) => ({
  "Access-Control-Allow-Origin": origin && allowed.includes(origin) ? origin : "null",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin"
});

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {...cors, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"}
  });
}

const allowedOrigins = (Deno.env.get("APP_ORIGINS") || "")
  .split(",").map(value => value.trim()).filter(Boolean);
const safeUrl = (value: unknown) => {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
};

Deno.serve(async request => {
  const origin = request.headers.get("Origin");
  const cors = corsHeaders(origin, allowedOrigins);
  if (request.method === "OPTIONS") return new Response(null, {status:204, headers:cors});
  if (origin && !allowedOrigins.includes(origin)) return json({error:"origin_not_allowed"}, 403, cors);
  if (request.method !== "POST") return json({error:"method_not_allowed"}, 405, cors);

  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!bearer || !projectUrl || !publicKey) return json({error:"authentication_required"}, 401, cors);

  // Verify the caller's session against Supabase Auth. No service-role key is used.
  const identity = await fetch(projectUrl + "/auth/v1/user", {
    headers:{apikey:publicKey, Authorization:"Bearer " + bearer}
  }).catch(() => null);
  if (!identity?.ok) return json({error:"invalid_session"}, 401, cors);

  const providerUrl = Deno.env.get("SEARCH_API_URL");
  const providerKey = Deno.env.get("SEARCH_API_KEY");
  if (!providerUrl || !providerKey) return json({error:"search_provider_not_configured"}, 503, cors);
  try {
    const parsedProviderUrl = new URL(providerUrl);
    if (parsedProviderUrl.protocol !== "https:" || parsedProviderUrl.username || parsedProviderUrl.password) {
      return json({error:"invalid_search_provider_url"}, 503, cors);
    }
  } catch { return json({error:"invalid_search_provider_url"}, 503, cors); }

  let query: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 12_000) return json({error:"request_too_large"}, 413, cors);
    query = JSON.parse(raw);
  } catch { return json({error:"invalid_json"}, 400, cors); }
  if (!query || typeof query.product !== "string" || !query.product.trim()) {
    return json({error:"product_required"}, 400, cors);
  }
  if (!["", "30", "90", "365"].includes(String(query.days ?? ""))) {
    return json({error:"invalid_days"}, 400, cors);
  }

  const dailyLimit = Number(Deno.env.get("SEARCH_DAILY_LIMIT") || 50);
  const quota = await fetch(projectUrl + "/rest/v1/rpc/consume_search_daily_limit", {
    method:"POST",
    headers:{apikey:publicKey, Authorization:"Bearer " + bearer, "Content-Type":"application/json"},
    body:JSON.stringify({p_daily_limit:dailyLimit})
  }).catch(() => null);
  if (!quota?.ok) return json({error:"search_limit_unavailable"}, 503, cors);
  if (await quota.json().catch(() => false) !== true) return json({error:"daily_search_limit_reached"}, 429, cors);

  try {
    // Configure a provider adapter/gateway that accepts this JSON query and
    // returns {leads:[...]}. SEARCH_API_KEY stays in the function secret store.
    const upstream = await fetch(providerUrl, {
      method:"POST",
      headers:{"Content-Type":"application/json", Authorization:"Bearer " + providerKey},
      body:JSON.stringify({...query, mode:"live", limit:100}),
      signal:AbortSignal.timeout(20_000)
    });
    if (!upstream.ok) return json({error:"search_provider_error", status:upstream.status}, 502, cors);
    const payload = await upstream.json();
    if (!Array.isArray(payload?.leads)) return json({error:"invalid_provider_response"}, 502, cors);
    const leads = payload.leads.slice(0, 100).map((lead: Record<string, unknown>) => ({
      name:String(lead.name ?? "").trim(),
      market:String(lead.market ?? ""),
      type:String(lead.type ?? ""),
      business:String(lead.business ?? ""),
      website:safeUrl(lead.website),
      contact:String(lead.contact ?? ""),
      reason:String(lead.reason ?? ""),
      source:safeUrl(lead.source),
      date:String(lead.date ?? "")
    })).filter((lead: Record<string, string>) => lead.name && lead.source);
    return json({leads}, 200, cors);
  } catch {
    return json({error:"search_provider_unavailable"}, 502, cors);
  }
});
