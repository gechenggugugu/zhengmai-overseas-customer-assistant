import marketData from "../_shared/markets.json" with {type:"json"};

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

Deno.serve(async request => {
  const origin = request.headers.get("Origin");
  const cors = corsHeaders(origin, allowedOrigins);
  if (origin && !allowedOrigins.includes(origin)) return json({error:"origin_not_allowed"}, 403, cors);
  if (request.method === "OPTIONS") return new Response(null, {status:204, headers:cors});
  if (request.method !== "POST") return json({error:"method_not_allowed"}, 405, cors);

  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!bearer || !projectUrl || !publicKey) return json({error:"authentication_required"}, 401, cors);

  // Verify the caller's session against Supabase Auth. No service-role key is used.
  const identity = await fetch(projectUrl + "/auth/v1/user", {
    headers:{apikey:publicKey, Authorization:"Bearer " + bearer},
    signal:AbortSignal.timeout(8_000)
  }).catch(() => null);
  if (!identity?.ok) return json({error:"invalid_session"}, 401, cors);

  const providerUrl = Deno.env.get("SEARCH_API_URL") || "";
  const providerKey = Deno.env.get("SEARCH_API_KEY");
  if (!providerKey) return json({error:"search_provider_not_configured"}, 503, cors);
  if (providerUrl) try {
    const parsedProviderUrl = new URL(providerUrl);
    if (parsedProviderUrl.protocol !== "https:" || parsedProviderUrl.username || parsedProviderUrl.password) {
      return json({error:"invalid_search_provider_url"}, 503, cors);
    }
  } catch { return json({error:"invalid_search_provider_url"}, 503, cors); }

  let query: Record<string, unknown>;
  try {
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > 12_000) return json({error:"request_too_large"}, 413, cors);
    const raw = await readBodyWithinLimit(request, 12_000);
    if (raw === null) return json({error:"request_too_large"}, 413, cors);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({error:"invalid_search_input"}, 400, cors);
    query = parsed as Record<string, unknown>;
  } catch { return json({error:"invalid_json"}, 400, cors); }
  if (!query || typeof query.product !== "string" || !query.product.trim()) {
    return json({error:"product_required"}, 400, cors);
  }
  if (query.product.trim().length > 120 ||
      !["market", "type", "keyword"].every(key => query[key] === undefined ||
        (typeof query[key] === "string" && query[key].length <= (key === "keyword" ? 120 : 100)))) {
    return json({error:"invalid_search_input"}, 400, cors);
  }
  if (query.days !== undefined && !["", "30", "90", "365", 30, 90, 365].includes(query.days as string | number)) {
    return json({error:"invalid_days"}, 400, cors);
  }
  const requestedMarket = marketFor(query.market);
  if (query.market && !requestedMarket) return json({error:"invalid_market"}, 400, cors);
  query.market = requestedMarket?.code || "";

  const provider = Deno.env.get("SEARCH_PROVIDER") || "tavily";
  if (!["tavily", "brave"].includes(provider)) return json({error:"search_provider_not_configured"}, 503, cors);

  const quota = await fetch(projectUrl + "/rest/v1/rpc/consume_search_daily_limit", {
    method:"POST",
    headers:{apikey:publicKey, Authorization:"Bearer " + bearer, "Content-Type":"application/json"},
    body:"{}"
  }).catch(() => null);
  if (!quota?.ok) return json({error:"search_limit_unavailable"}, 503, cors);
  const quotaResult = await quota.json().catch(() => null);
  if (quotaResult === false) return json({error:"daily_search_limit_reached"}, 429, cors);
  if (quotaResult !== true) return json({error:"search_limit_unavailable"}, 503, cors);

  try {
    const payload = await searchWithProvider(provider, providerUrl, providerKey, query);
    if (!Array.isArray(payload?.leads)) return json({error:"invalid_provider_response"}, 502, cors);
    let leads = payload.leads.slice(0, 100).map((lead: Record<string, unknown>) => ({
      name:String(lead.name ?? "").trim().slice(0, 240),
      market:String(lead.market ?? ""),
      marketStatus:String(lead.marketStatus ?? "待核实"),
      type:String(lead.type ?? ""),
      typeStatus:String(lead.typeStatus ?? "待核实"),
      business:String(lead.business ?? ""),
      website:safeUrl(lead.website),
      websiteStatus:String(lead.websiteStatus ?? "搜索结果站点，尚未核实为公司官网"),
      nameStatus:String(lead.nameStatus ?? "搜索结果标题，需确认公司主体"),
      contact:String(lead.contact ?? "").slice(0, 320),
      contactStatus:String(lead.contactStatus ?? "未获取").slice(0, 120),
      matchScore:Math.max(0, Math.min(100, Number(lead.matchScore) || 0)),
      emailDraft:String(lead.emailDraft ?? "").slice(0, 5000),
      reason:String(lead.reason ?? "").slice(0, 500),
      source:safeUrl(lead.source),
      date:String(lead.date ?? "")
    })).filter((lead: Record<string, unknown>) => Boolean(lead.name && lead.source));
    leads = await maybeAiEnrich(leads, query);
    return json({leads}, 200, cors);
  } catch {
    return json({error:"search_provider_unavailable"}, 502, cors);
  }
});

async function maybeAiEnrich(leads: Record<string, unknown>[], query: Record<string, unknown>) {
  const endpoint = Deno.env.get("AI_API_URL"), key = Deno.env.get("AI_API_KEY"), model = Deno.env.get("AI_MODEL");
  if (!endpoint || !key || !model || leads.length === 0) return leads;
  try {
    if (new URL(endpoint).protocol !== "https:") return leads;
    const aiResults = leads.slice(0,20);
    const response = await fetch(endpoint, {method:"POST", headers:{Authorization:`Bearer ${key}`, "Content-Type":"application/json"},
      body:JSON.stringify({model, temperature:0, max_tokens:5000, response_format:{type:"json_object"}, messages:[
        {role:"system",content:"Evaluate B2B fit for a commercial bakery equipment manufacturer. Use only supplied search evidence. Never infer or invent contact details, countries, product claims, or facts. Return JSON {items:[{source,score,reason,emailDraft}]}. Scores are advisory and require human review. Draft a short English first-contact email with placeholders where evidence is missing; do not claim prior contact or verified facts."},
        {role:"user",content:JSON.stringify({criteria:{product:query.product,market:query.market,type:query.type},results:aiResults.map(({name,market,type,business,source,contact})=>({name,market,type,business:String(business||"").slice(0,900),source,contact}))})}
      ]}),signal:AbortSignal.timeout(12_000)});
    if (!response.ok) return leads;
    const result = await response.json();
    const parsed = JSON.parse(result.choices?.[0]?.message?.content || "{}");
    const bySource = new Map((parsed.items || []).filter((item: Record<string, unknown>) => typeof item.source === "string")
      .map((item: Record<string, unknown>) => [item.source, item]));
    return leads.map(lead => {
      const item = bySource.get(lead.source) as Record<string, unknown> | undefined;
      if (!item) return lead;
      return {...lead, matchScore:Math.max(0, Math.min(100, Number(item.score) || Number(lead.matchScore) || 0)),
        reason:String(item.reason || lead.reason).slice(0,500),
        emailDraft:typeof item.emailDraft === "string" ? item.emailDraft.slice(0,5000) : ""};
    });
  } catch { return leads; }
}

function companyTerms(query: Record<string, unknown>, language: string) {
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

async function searchWithProvider(provider: string, endpoint: string, key: string, query: Record<string, unknown>) {
  // One authenticated request consumes one quota unit. Keep provider calls at one
  // basic search (one Tavily credit) so quota and external usage stay aligned.
  const languages = ["en"];
  const searches = await Promise.all(languages.map(async language => {
    const text = companyTerms(query, language);
    const selectedMarket = markets.find(item => item.code === String(query.market || ""));
    let response: Response;
    if (provider === "tavily") {
      const days = Number(query.days || 0);
      const endDate = new Date().toISOString().slice(0, 10);
      const startDate = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : undefined;
      response = await fetch(endpoint || "https://api.tavily.com/search", {
        method:"POST", headers:{Authorization:`Bearer ${key}`, "Content-Type":"application/json"},
        body:JSON.stringify({query:text, search_depth:"basic", max_results:10, topic:"general", language,
          country:selectedMarket?.tavily ? selectedMarket.en.toLocaleLowerCase() : null, include_answer:false, include_usage:true,
          ...(startDate ? {start_date:startDate, end_date:endDate, include_published_date:true} : {})}),
        signal:AbortSignal.timeout(20_000)
      });
    } else if (provider === "brave") {
      const url = new URL(endpoint || "https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", text); url.searchParams.set("count", "10");
      if (selectedMarket?.brave) url.searchParams.set("country", selectedMarket.code);
      url.searchParams.set("search_lang", language);
      response = await fetch(url, {headers:{"X-Subscription-Token":key}, signal:AbortSignal.timeout(20_000)});
    } else throw new Error("unsupported_provider");
    if (!response.ok) throw new Error("provider_http_error");
    const data = await response.json();
    const items = provider === "tavily" ? (data.results || []) : (data.web?.results || []);
    return items.map((item: Record<string, unknown>) => ({item, language}));
  }));
  const seen = new Set<string>();
  const leads = searches.flat().map(({item, language}) => {
    const url = safeUrl(item.url);
    const title = String(item.title || "").trim();
    const content = String(item.content || item.description || "").slice(0, 1600);
    if (!url || !title) return null;
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
  return {leads};
}
