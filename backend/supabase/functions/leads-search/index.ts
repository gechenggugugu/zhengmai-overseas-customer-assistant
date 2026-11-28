import marketData from "./_shared/markets.json" with {type:"json"};
import {classifySearchFailure, logSearchFailure} from "./diagnostics.mjs";
import {executeReservedSearch} from "./quota-lifecycle.mjs";

const corsHeaders = (origin: string | null, allowed: string[]) => ({
  "Access-Control-Allow-Origin": origin && allowed.includes(origin) ? origin : "null",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin"
});

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {...cors, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"}
  });
}

function logStage(requestId: string, stage: string, provider = "") {
  console.log(JSON.stringify({event:"leads_search_stage", requestId, stage, ...(provider ? {provider} : {})}));
}

async function quotaRpc(config: {url: string, key: string},
  name: "reserve_search_quota" | "confirm_search_quota" | "refund_search_quota",
  args: {p_request_id: string, p_user_id: string, p_attempt_id: string},
  attempts = 1): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(config.url + "/rest/v1/rpc/" + name, {
        method:"POST", headers:{apikey:config.key, Authorization:"Bearer " + config.key, "Content-Type":"application/json"},
        body:JSON.stringify(args), signal:AbortSignal.timeout(8_000), redirect:"error"
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || typeof result !== "object") {
        const error = Object.assign(new Error("quota_rpc_failed"), {code:"QUOTA_RPC_FAILED", status:response.status});
        if (response.status < 500 || attempt + 1 >= attempts) throw error;
        lastError = error;
        continue;
      }
      return result as Record<string, unknown>;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("quota_rpc_failed");
}

async function readBodyWithinLimit(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const allowedOrigins = [...new Set([
  "http://127.0.0.1:4173",
  ...(Deno.env.get("APP_ORIGINS") || "").split(",").map(value => value.trim()).filter(Boolean)
])];
const safeUrl = (value: unknown) => {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
};
type Market = {code:string; zh:string; en:string; aliases?:string[]; tavily:boolean; brave:boolean};
const markets = marketData as Market[];
const marketFor = (value: unknown) => {
  const name = String(value || "").trim().toLocaleLowerCase();
  if (!name) return null;
  return markets.find(market => [market.code, market.zh, market.en, ...(market.aliases || [])].some(item => item.toLocaleLowerCase() === name)) ||
    (["uae", "阿联酋"].includes(name) ? markets.find(market => market.code === "AE") : null);
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function cacheKey(provider: string, query: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(`${provider}:${stableJson(query)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function serviceRestConfig() {
  const url = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  // Runtime-injected server key only; never sent to the browser or included in logs.
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? {url, key} : null;
}

async function readCachedSearch(key: string): Promise<Record<string, unknown> | null> {
  const config = serviceRestConfig();
  if (!config) return null;
  try {
    const response = await fetch(`${config.url}/rest/v1/search_response_cache?cache_key=eq.${key}&select=response,provider_credits,expires_at`, {
      headers:{apikey:config.key, Authorization:`Bearer ${config.key}`}, signal:AbortSignal.timeout(3_000)
    });
    if (!response.ok) return null;
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || Date.parse(row.expires_at) <= Date.now() || !row.response || typeof row.response !== "object") return null;
    return row;
  } catch { return null; }
}

async function writeCachedSearch(key: string, provider: string, responseBody: Record<string, unknown>, credits: number | null) {
  const config = serviceRestConfig();
  if (!config) return;
  try {
    await fetch(`${config.url}/rest/v1/search_response_cache?on_conflict=cache_key`, {
      method:"POST", headers:{apikey:config.key, Authorization:`Bearer ${config.key}`, "Content-Type":"application/json",
        Prefer:"resolution=merge-duplicates,return=minimal"},
      body:JSON.stringify({cache_key:key, provider, response:responseBody, provider_credits:credits,
        created_at:new Date().toISOString(), expires_at:new Date(Date.now()+6*60*60*1000).toISOString()}),
      signal:AbortSignal.timeout(3_000)
    });
  } catch { /* cache is best effort; provider search remains authoritative */ }
}

Deno.serve(async request => {
  let requestId: string = crypto.randomUUID();
  let stage = "request";
  let provider = "";
  try {
  const origin = request.headers.get("Origin");
  const cors = corsHeaders(origin, allowedOrigins);
  if (origin && !allowedOrigins.includes(origin)) return json({error:"origin_not_allowed"}, 403, cors);
  if (request.method === "OPTIONS") return new Response(null, {status:204, headers:cors});
  if (request.method !== "POST") return json({error:"method_not_allowed"}, 405, cors);

  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!bearer || !projectUrl || !publicKey) return json({error:"authentication_required", code:"authentication_required"}, 401, cors);

  // Derive the quota owner from the verified Auth response, never the request body.
  stage = "auth_verification";
  const identity = await fetch(projectUrl + "/auth/v1/user", {
    headers:{apikey:publicKey, Authorization:"Bearer " + bearer},
    signal:AbortSignal.timeout(8_000)
  }).catch(() => null);
  if (!identity?.ok) return json({error:"invalid_session"}, 401, cors);
  const verifiedUser = await identity.json().catch(() => null);
  const userId = verifiedUser?.id;
  if (typeof userId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(userId)) {
    return json({error:"invalid_session"}, 401, cors);
  }
  logStage(requestId, "auth_verified");

  provider = Deno.env.get("SEARCH_PROVIDER") || "tavily";
  const providerUrl = Deno.env.get("SEARCH_API_URL") || "";
  const providerKey = Deno.env.get("SEARCH_API_KEY");
  stage = "configuration";
  if (!providerKey) {
    const error = Object.assign(new Error(), {code:"SEARCH_CONFIG_MISSING"});
    const diagnostic = logSearchFailure({requestId, stage:"configuration", provider, error});
    return json({error:diagnostic.code, code:diagnostic.code, message:diagnostic.message, requestId}, 503, cors);
  }
  if (providerUrl) try {
    const parsedProviderUrl = new URL(providerUrl);
    if (parsedProviderUrl.protocol !== "https:" || parsedProviderUrl.username || parsedProviderUrl.password) {
      return json({error:"invalid_search_provider_url"}, 503, cors);
    }
  } catch { return json({error:"invalid_search_provider_url"}, 503, cors); }

  let query: Record<string, unknown>;
  try {
    stage = "input_validation";
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > 12_000) return json({error:"request_too_large"}, 413, cors);
    const raw = await readBodyWithinLimit(request, 12_000);
    if (raw === null) return json({error:"request_too_large"}, 413, cors);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({error:"invalid_search_input"}, 400, cors);
    query = parsed as Record<string, unknown>;
  } catch { return json({error:"invalid_json"}, 400, cors); }
  if (query.requestId !== undefined) {
    if (typeof query.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query.requestId)) {
      return json({error:"invalid_request_id"}, 400, cors);
    }
    requestId = query.requestId;
  }
  delete query.requestId;
  const contactSearch = query?.action === "contacts";
  if (contactSearch && (!query.company || typeof query.company !== "object" || Array.isArray(query.company))) return json({error:"company_required"}, 400, cors);
  if (!contactSearch && (!query || typeof query.product !== "string" || !query.product.trim())) {
    return json({error:"product_required"}, 400, cors);
  }
  if (contactSearch) {
    const company = query.company as Record<string, unknown>;
    if (typeof company.name !== "string" || !company.name.trim() || company.name.length > 240 ||
        (company.website !== undefined && (typeof company.website !== "string" || company.website.length > 500)) ||
        (company.market !== undefined && (typeof company.market !== "string" || company.market.length > 100))) return json({error:"invalid_company"}, 400, cors);
    const requestedMarket = marketFor(company.market);
    if (company.market && company.market !== "待核实" && !requestedMarket) return json({error:"invalid_market"}, 400, cors);
    query.company = {name:company.name.trim(), website:safeUrl(company.website), market:requestedMarket?.code || ""};
  }
  if (!contactSearch && ((query.product as string).trim().length > 120 ||
      !["market", "type", "keyword"].every(key => query[key] === undefined ||
        (typeof query[key] === "string" && query[key].length <= (key === "keyword" ? 120 : 100))))) {
    return json({error:"invalid_search_input"}, 400, cors);
  }
  if (!contactSearch && query.days !== undefined && !["", "30", "90", "365", 30, 90, 365].includes(query.days as string | number)) {
    return json({error:"invalid_days"}, 400, cors);
  }
  const requestedMarket = contactSearch ? null : marketFor(query.market);
  if (!contactSearch && query.market && !requestedMarket) return json({error:"invalid_market"}, 400, cors);
  if (!contactSearch) query.market = requestedMarket?.code || "";

  if (!["tavily", "brave"].includes(provider)) return json({error:"search_provider_not_configured"}, 503, cors);

  stage = "quota_reservation";
  const quotaConfig = serviceRestConfig();
  if (!quotaConfig) {
    logStage(requestId, "quota_service_config_missing", provider);
    return json({error:"search_limit_unavailable", code:"search_limit_unavailable", requestId}, 503, cors);
  }
  const quotaArgs = {p_request_id:requestId, p_user_id:userId, p_attempt_id:crypto.randomUUID()};
  const lifecycle = await executeReservedSearch({
    requestId,
    signal:request.signal,
    reserve:async () => quotaRpc(quotaConfig, "reserve_search_quota", quotaArgs),
    confirm:async () => quotaRpc(quotaConfig, "confirm_search_quota", quotaArgs, 2),
    refund:async () => quotaRpc(quotaConfig, "refund_search_quota", quotaArgs),
    search:async () => {
      stage = "provider_fetch_and_parse";
      const providerSignal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
      const responseCacheKey = contactSearch ? "" : await cacheKey(provider, query);
      if (responseCacheKey) {
        const cached = await readCachedSearch(responseCacheKey);
        if (cached) return {...cached.response as Record<string, unknown>, usage:{provider, apiCredits:0, cacheHit:true}};
      }
      const payload = await searchWithProvider(provider, providerUrl, providerKey, query, providerSignal);
      logStage(requestId, "provider_response_parsed", provider);
      if (contactSearch) {
        if (!Array.isArray(payload?.contacts)) throw Object.assign(new Error(), {code:"PROVIDER_INVALID_RESPONSE"});
        return {contacts:payload.contacts.slice(0, 30), searchedAt:new Date().toISOString(),
          usage:{provider, apiCredits:payload.apiCredits ?? null, cacheHit:false}};
      }
      if (!Array.isArray(payload?.leads)) throw Object.assign(new Error(), {code:"PROVIDER_INVALID_RESPONSE"});
      const leads = payload.leads.filter(lead => lead !== null).slice(0, 100).map(lead => ({
        name:String(lead.name ?? "").trim().slice(0, 240),
        market:String(lead.market ?? ""), marketStatus:String(lead.marketStatus ?? "待核实"),
        type:String(lead.type ?? ""), typeStatus:String(lead.typeStatus ?? "待核实"),
        business:String(lead.business ?? ""), website:safeUrl(lead.website),
        websiteStatus:String(lead.websiteStatus ?? "搜索结果站点，尚未核实为公司官网"),
        nameStatus:String(lead.nameStatus ?? "搜索结果标题，需确认公司主体"),
        contact:String(lead.contact ?? "").slice(0, 320), contactStatus:String(lead.contactStatus ?? "未获取").slice(0, 120),
        matchScore:Math.max(0, Math.min(100, Number(lead.matchScore) || 0)),
        emailDraft:"", reason:String(lead.reason ?? "").slice(0, 500),
        source:safeUrl(lead.source), date:String(lead.date ?? "")
      })).filter((lead: Record<string, unknown>) => Boolean(lead.name && lead.source));
      const enrichedLeads = await maybeAiEnrich(leads, query, request.signal);
      if (request.signal.aborted) throw Object.assign(new Error(), {code:"REQUEST_CANCELLED"});
      const responseBody = {leads:enrichedLeads};
      if (responseCacheKey) await writeCachedSearch(responseCacheKey, provider, responseBody,
        Number.isInteger(payload.apiCredits) ? payload.apiCredits as number : null);
      return {...responseBody, usage:{provider, apiCredits:payload.apiCredits ?? null, cacheHit:false}};
    }
  });

  if (lifecycle.kind === "rejected") {
    const quotaResult = lifecycle.quota;
    if (quotaResult?.reason === "daily" || quotaResult?.reason === "monthly") {
      return json({error:"search_quota_exceeded", code:"search_quota_exceeded", reason:quotaResult.reason, quota:quotaResult}, 429, cors);
    }
    if (quotaResult?.reason === "duplicate_request" || quotaResult?.reason === "request_closed") {
      return json({error:"duplicate_search_request", code:"duplicate_search_request", requestId}, 409, cors);
    }
    return json({error:"search_limit_unavailable", code:"search_limit_unavailable", requestId}, 503, cors);
  }
  if (lifecycle.kind === "cancelled") {
    logStage(requestId, "request_cancelled", provider);
    return json({error:"search_request_cancelled", code:"search_request_cancelled", requestId,
      quotaRefunded:lifecycle.refunded}, 499, cors);
  }
  if (lifecycle.kind === "failed") {
    if (stage === "quota_reservation") {
      logStage(requestId, lifecycle.refunded ? "quota_reservation_failed_released" : "quota_reservation_failed_pending", provider);
      return json({error:"search_limit_unavailable", code:"search_limit_unavailable", requestId,
        quotaRefunded:lifecycle.refunded}, 503, cors);
    }
    const diagnostic = logSearchFailure({requestId, stage, provider, error:lifecycle.error});
    logStage(requestId, lifecycle.refunded ? "quota_refunded" : "quota_refund_pending", provider);
    return json({error:diagnostic.code, code:diagnostic.code, message:diagnostic.message, requestId,
      quotaRefunded:lifecycle.refunded}, 502, cors);
  }
  logStage(requestId, "quota_confirmed", provider);
  return json(lifecycle.value, 200, cors);
  } catch (error) {
    const diagnostic = logSearchFailure({requestId, stage, provider, error});
    const origin = request.headers.get("Origin");
    return json({error:diagnostic.code, code:diagnostic.code, message:diagnostic.message, requestId}, 502,
      corsHeaders(origin, allowedOrigins));
  }
});

async function maybeAiEnrich(leads: Record<string, unknown>[], query: Record<string, unknown>, requestSignal?: AbortSignal) {
  const endpoint = Deno.env.get("AI_API_URL"), key = Deno.env.get("AI_API_KEY"), model = Deno.env.get("AI_MODEL");
  if (!endpoint || !key || !model || leads.length === 0) return leads;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password) return leads;
    const aiResults = leads.slice(0,20);
    const sources = new Set(aiResults.map(lead => lead.source));
    const response = await fetch(endpoint, {method:"POST", headers:{Authorization:`Bearer ${key}`, "Content-Type":"application/json"},
      body:JSON.stringify({model, temperature:0, max_tokens:5000, response_format:{type:"json_object"}, messages:[
        {role:"system",content:"Evaluate B2B fit for a commercial bakery equipment manufacturer. Use only supplied search evidence. Never infer or invent contact details, countries, product claims, or facts. Return JSON {items:[{source,score,reason,emailDraft}]}. Scores are advisory and require human review. Draft a short English first-contact email with placeholders where evidence is missing; do not claim prior contact or verified facts."},
        {role:"user",content:JSON.stringify({criteria:{product:query.product,market:query.market,type:query.type},results:aiResults.map(({name,market,type,business,source})=>({name,market,type,business:String(business||"").slice(0,900),source}))})}
      ]}),redirect:"error",
      signal:requestSignal ? AbortSignal.any([requestSignal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000)});
    if (!response.ok) return leads;
    const result = await response.json();
    const parsed = JSON.parse(result.choices?.[0]?.message?.content || "{}");
    if (!Array.isArray(parsed?.items)) return leads;
    const bySource = new Map<string, Record<string, unknown>>();
    for (const item of parsed.items) {
      if (typeof item?.source !== "string" || !sources.has(item.source) || bySource.has(item.source)) continue;
      bySource.set(item.source, item);
    }
    return leads.map(lead => {
      const item = typeof lead.source === "string" ? bySource.get(lead.source) : undefined;
      if (!item) return lead;
      return {...lead,
        matchScore:typeof item.score === "number" && Number.isFinite(item.score)
          ? Math.max(0, Math.min(100, item.score)) : lead.matchScore,
        reason:typeof item.reason === "string" && item.reason.trim() ? item.reason.trim().slice(0,500) : lead.reason,
        emailDraft:typeof item.emailDraft === "string" ? item.emailDraft.trim().slice(0,5000) : lead.emailDraft};
    });
  } catch { return leads; }
}

function companyTerms(query: Record<string, unknown>, language: string) {
  if (query.action === "contacts") {
    const company = query.company as Record<string, unknown>;
    const market = markets.find(item => item.code === String(company.market || ""));
    return `"${String(company.name)}" (Purchasing Manager OR Procurement Manager OR Import Manager OR Sourcing Manager OR Owner OR Founder OR Managing Director OR CEO) ${market?.en || ""}`.trim();
  }
  const product = String(query.product || "commercial bakery equipment");
  const type = String(query.type || "importer distributor");
  const market = markets.find(item => item.code === String(query.market || ""));
  const keyword = String(query.keyword || "");
  const terms: Record<string, string> = {
    en:`${product} ${market?.en || ""} bakery equipment distributor importer dealer wholesaler supplier ${type} ${keyword}`.trim(),
    zh:`${market?.zh || ""} ${product} 烘焙设备 设备经销商 进口商 批发商 ${keyword}`.trim(),
    es:`${market?.en || ""} equipos de panadería distribuidor importador ${product} ${keyword}`.trim(),
    fr:`${market?.en || ""} équipement boulangerie distributeur importateur ${product} ${keyword}`.trim(),
    de:`${market?.en || ""} Bäckereitechnik Händler Importeur ${product} ${keyword}`.trim(),
    ar:`${market?.en || ""} معدات مخابز موزع مستورد ${product} ${keyword}`.trim()
  };
  return terms[language] || `${product} ${type}`;
}

async function searchWithProvider(provider: string, endpoint: string, key: string, query: Record<string, unknown>, signal?: AbortSignal) {
  // One authenticated request consumes one quota unit. Keep provider calls at one
  // basic search (one Tavily credit) so quota and external usage stay aligned.
  const languages = ["en"];
  const selectedMarket = markets.find(item => item.code === String(query.market || ""));
  const days = Number(query.days || 0);
  const now = Date.now();
  const endDate = new Date(now).toISOString().slice(0, 10);
  const startDate = days ? new Date(now - days * 86_400_000).toISOString().slice(0, 10) : undefined;
  const searches = await Promise.all(languages.map(async language => {
    const text = companyTerms(query, language);
    let response: Response;
    if (provider === "tavily") {
      response = await fetch(endpoint || "https://api.tavily.com/search", {
        method:"POST", headers:{Authorization:`Bearer ${key}`, "Content-Type":"application/json"},
        body:JSON.stringify({query:text, search_depth:"basic", max_results:10, topic:"general", language,
          country:selectedMarket?.tavily ? selectedMarket.en.toLocaleLowerCase() : null, include_answer:false, include_usage:true,
          ...(startDate ? {start_date:startDate, end_date:endDate, filter_by_published_date:true} : {})}),
        redirect:"error", signal:signal || AbortSignal.timeout(20_000)
      });
    } else if (provider === "brave") {
      const url = new URL(endpoint || "https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", text); url.searchParams.set("count", "10");
      if (selectedMarket?.brave) url.searchParams.set("country", selectedMarket.code);
      if (startDate) url.searchParams.set("freshness", `${startDate}to${endDate}`);
      url.searchParams.set("search_lang", language);
      response = await fetch(url, {headers:{"X-Subscription-Token":key}, redirect:"error",
        signal:signal || AbortSignal.timeout(20_000)});
    } else throw new Error("unsupported_provider");
    if (!response.ok) throw Object.assign(new Error(), {code:"PROVIDER_HTTP_ERROR", status:response.status});
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = await response.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("invalid_provider_object");
      data = parsed as Record<string, unknown>;
    }
    catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw Object.assign(new Error(), {code:"PROVIDER_INVALID_JSON", cause:error});
    }
    const braveWeb = data.web && typeof data.web === "object" && !Array.isArray(data.web)
      ? data.web as Record<string, unknown> : null;
    const items = provider === "tavily" ? data.results : braveWeb?.results;
    if (!Array.isArray(items) || items.some((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const result = item as Record<string, unknown>;
      return typeof result.url !== "string" || !safeUrl(result.url) ||
        typeof result.title !== "string" || !result.title.trim();
    })) {
      throw Object.assign(new Error(), {code:"PROVIDER_INVALID_RESPONSE"});
    }
    const usage = data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : null;
    const apiCredits = provider === "tavily" && usage && Number.isInteger(usage.credits) && Number(usage.credits) >= 0
      ? Number(usage.credits) : null;
    return {items:items.map((item: Record<string, unknown>) => ({item, language})), apiCredits};
  }));
  const seen = new Set<string>();
  const flat = searches.flatMap(search => search.items);
  const apiCredits = provider === "tavily" && searches.every(search => search.apiCredits !== null)
    ? searches.reduce((sum, search) => sum + (search.apiCredits || 0), 0) : null;
  if (query.action === "contacts") {
    const company = query.company as Record<string, unknown>;
    const companyName = String(company.name);
    const rolePattern = /\b(Purchasing Manager|Procurement Manager|Import Manager|Sourcing Manager|Equipment Purchasing Manager|Owner|Founder|Managing Director|CEO|Chief Executive Officer)\b/i;
    const contacts = flat.map(({item}) => {
      const source = safeUrl(item.url);
      const title = String(item.title || "").trim();
      const evidence = (title + " " + String(item.content || item.description || "")).slice(0,1600);
      const roleMatch = evidence.match(rolePattern);
      if (!source || !roleMatch || !evidence.toLocaleLowerCase().includes(companyName.toLocaleLowerCase())) return null;
      const head = title.split(/\s(?:-|\||–|—)\s/)[0].trim();
      const personName = /[A-Za-z][A-Za-z.'’-]+(?:\s+[A-Za-z][A-Za-z.'’-]+){1,3}/.test(head) ? head : "";
      if (!personName || personName.length > 100 || personName.toLocaleLowerCase() === companyName.toLocaleLowerCase()) return null;
      const role = roleMatch[1];
      const socialUrl = /(^|\.)linkedin\.com$|(^|\.)facebook\.com$/i.test(new URL(source).hostname) ? source : "";
      const emails = evidence.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
      const phoneMatch = evidence.match(/(?:phone|tel(?:ephone)?|call)\s*[:#-]?\s*(\+?\d[\d ().-]{7,}\d)/i);
      const companyMarket = markets.find(market => market.code === String(company.market || ""));
      const procurement = /purchasing|procurement|import manager|sourcing/i.test(role);
      const companyMatch = evidence.toLocaleLowerCase().includes(companyName.toLocaleLowerCase());
      const matchScore = Math.min(95, 45 + (procurement ? 25 : 10) + (companyMatch ? 25 : 0) + (socialUrl ? 5 : 0));
      return {name:personName, position:role, target:procurement ? "采购负责人" : "公司老板/决策人",
        country:companyMarket?.zh || "待核实", socialUrl, email:emails[0] || "", phone:phoneMatch?.[1]?.trim() || "",
        evidenceSource:source, evidence:evidence.slice(0,1200), matchScore,
        verificationStatus:"待核实", checkedAt:new Date().toISOString()};
    }).filter(Boolean);
    const uniqueContacts = [...new Map(contacts.map(contact => [(contact as Record<string, unknown>).name + "|" + (contact as Record<string, unknown>).position, contact])).values()];
    uniqueContacts.sort((a,b) => Number((b as Record<string,unknown>).target === "采购负责人") - Number((a as Record<string,unknown>).target === "采购负责人"));
    return {contacts:uniqueContacts, apiCredits};
  }
  const seenCompanies = new Set<string>();
  const leads = flat.map(({item, language}) => {
    const url = safeUrl(item.url);
    const title = String(item.title || "").trim();
    const content = String(item.content || item.description || "").slice(0, 1600);
    if (!url || !title) return null;
    const companyKey = title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (companyKey && seenCompanies.has(companyKey)) return null;
    if (companyKey) seenCompanies.add(companyKey);
    const websiteUrl = new URL(url);
    const hostname = websiteUrl.hostname.toLocaleLowerCase().replace(/^www\./, "");
    if (seen.has(hostname)) return null;
    seen.add(hostname);
    const website = websiteUrl.origin;
    const emails = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
    const evidence = title + " " + content;
    const requestedMarket = selectedMarket;
    const aliases = requestedMarket ? [requestedMarket.zh, requestedMarket.en, ...(requestedMarket.aliases || []),
      ...(requestedMarket.code === "AE" ? ["uae", "阿联酋", "emirates"] : []),
      ...(requestedMarket.code === "US" ? ["usa", "u.s."] : []),
      ...(requestedMarket.code === "GB" ? ["uk", "britain"] : [])] : [];
    const market = requestedMarket && aliases.some(value => evidence.toLocaleLowerCase().includes(value.toLocaleLowerCase()))
      ? (requestedMarket.code === "AE" ? "阿联酋" : requestedMarket.zh) : "待核实";
    const kind = /(importer|进口商)/i.test(evidence) ? "设备进口商" : /(distributor|dealer|wholesale|经销商|批发)/i.test(evidence) ? "设备经销商" : /(integrator|engineering|工程集成)/i.test(evidence) ? "工程集成商" : "待核实";
    const score = Math.min(95, 35 + (/(bakery|bake|oven|烘焙|bakker|boulanger|panader)/i.test(evidence) ? 30 : 0) + (/(distributor|importer|dealer|wholesale|经销|进口|grosshandel)/i.test(evidence) ? 25 : 0));
    return {name:title, nameStatus:"搜索结果标题，需确认公司主体", market, marketStatus:market === "待核实" ? "摘要未能确认国家 / 地区" : "摘要提及目标市场，仍需人工核实", type:kind, typeStatus:kind === "待核实" ? "摘要未能确认客户类型" : "由摘要关键词初步识别，仍需人工核实", business:content,
      website, contact:emails[0] || "", contactStatus:emails.length ? "搜索摘要公开出现 · 请点开来源核实" : "未获取",
      websiteStatus:"搜索结果站点，尚未核实为公司官网",
      reason:`搜索摘要匹配评分 ${score}/100（规则初筛，需人工复核）`, matchScore:score, source:url,
      date:String(item.published_date || ""), language, sourceType:"live"};
  }).filter(Boolean);
  return {leads, apiCredits};
}
