// Public client settings only. Never put provider credentials here.
const publicSettings = globalThis.ZHENGMAI_CONFIG || {};
const supabaseUrl = typeof publicSettings.supabaseUrl === "string" ? publicSettings.supabaseUrl.replace(/\/$/, "") : "";
export const config = Object.freeze({
  searchEndpoint: typeof publicSettings.searchEndpoint === "string" && publicSettings.searchEndpoint
    ? publicSettings.searchEndpoint
    : (supabaseUrl ? supabaseUrl + "/functions/v1/leads-search" : ""),
  supabaseUrl,
  supabaseAnonKey: typeof publicSettings.supabaseAnonKey === "string" ? publicSettings.supabaseAnonKey : "",
  storageKey: "zhengmai.crm.v1",
  maxResults: 100
});
export const statuses = ["待联系", "已联系", "已回复", "报价中", "成交", "暂缓"];
const samples = [
  ["Atlas Bakery Supply", "atlas", "马来西亚", "设备经销商", "商用烤箱、醒发箱", "主营烤箱与发酵设备，适合介绍正麦整套烘焙设备。", "commercial ovens and proofers", 4],
  ["Meranti Foodservice Trading", "meranti", "马来西亚", "设备进口商", "商用烤箱、和面机", "设备进口渠道，适合沟通正麦品牌代理及 OEM 合作。", "commercial ovens and dough mixers", 12],
  ["Dune Pro Kitchen", "dune", "阿联酋", "设备经销商", "商用烤箱、和面机", "具备烘焙设备品类，可围绕商用烤箱组合开发。", "commercial ovens and dough mixers", 8],
  ["Harbour Bake Systems", "harbour", "澳大利亚", "工程集成商", "商用烤箱、烘焙生产线", "提供烘焙产线项目服务，适合探讨整线配套。", "bakery production lines", 32],
  ["Lotus Oven Trading", "lotus", "越南", "设备进口商", "商用烤箱、醒发箱", "进口与分销烘焙设备，适合提供组合选型资料。", "commercial ovens and proofers", 21],
  ["Najd Bakery Projects", "najd", "沙特阿拉伯", "工程集成商", "和面机、烘焙生产线", "烘焙工厂项目采购场景，适合评估产线设备配套。", "dough mixers and bakery production lines", 105]
];
const aliases = {"malaysia":"马来西亚","uae":"阿联酋","united arab emirates":"阿联酋","australia":"澳大利亚","vietnam":"越南","saudi arabia":"沙特阿拉伯","commercial oven":"商用烤箱","dough mixer":"和面机","proofer":"醒发箱","bakery production line":"烘焙生产线","bakery equipment":"商用烘焙设备"};
export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
const normalized = value => String(value ?? "").trim().toLowerCase();
let cloudAdapter = null;
let storageNamespace = "";
export function leadKey(lead) {
  const site = safeUrl(lead.website);
  const domain = site && new URL(site).hostname.replace(/^www\./, "");
  return lead.sourceType + "|" + (domain || normalized(lead.name) + "|" + normalized(lead.market));
}
export function uniqueLeads(leads) {
  const keys = new Set();
  return leads.filter(lead => {
    const key = leadKey(lead);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}
export async function searchLeads(query, signal) {
  if (query.mode === "live") {
    if (!config.searchEndpoint) throw new Error("真实搜索尚未配置。请选择演示样本，或查看接入说明。");
    const headers = {"Content-Type":"application/json"};
    if (config.supabaseAnonKey) headers.apikey = config.supabaseAnonKey;
    const token = await cloudAdapter?.accessToken?.();
    if (!token) throw new Error("请先登录并验证邮箱后再搜索。");
    headers.Authorization = "Bearer " + token;
    const response = await fetch(config.searchEndpoint, {
      method: "POST", headers,
      body: JSON.stringify({...query, limit: config.maxResults}), signal
    });
    if (!response.ok) {
      const message = response.status === 401 ? "请先登录并验证邮箱后再搜索。" :
        response.status === 429 ? "搜索配额已用完，请在下个配额周期后重试。" :
        response.status === 503 ? "真实搜索服务尚未配置或暂不可用，请检查服务端设置。" :
        response.status >= 500 ? "搜索服务暂时不可用。请稍后手动重试。" :
        "搜索请求未通过校验（" + response.status + "）。";
      throw new Error(message);
    }
    const payload = await response.json();
    if (!Array.isArray(payload.leads)) throw new Error("真实搜索返回格式不符合接口约定。");
    return payload.leads.slice(0, config.maxResults).map(lead => ({
      name: String(lead.name ?? "").trim(), market: String(lead.market ?? ""),
      type: String(lead.type ?? ""), business: String(lead.business ?? ""),
      website: safeUrl(lead.website), contact: String(lead.contact ?? ""),
      reason: String(lead.reason ?? ""), source: safeUrl(lead.source),
      date: String(lead.date ?? ""), emailFocus: "", sourceType: "live"
    })).filter(lead => lead.name && lead.source);
  }
  const product = aliases[normalized(query.product)] || query.product;
  const market = aliases[normalized(query.market)] || query.market;
  const leads = samples.map(([name, slug, country, type, business, reason, emailFocus, age]) => ({
    name, market: country, type, business, reason, emailFocus, age,
    website: "https://" + slug + ".example", contact: "sales@" + slug + ".example",
    source: "https://" + slug + ".example/catalog",
    date: new Date(Date.now() - age * 86400000).toISOString().slice(0, 10),
    sourceType: "demo"
  })).filter(lead =>
    (!product || product === "商用烘焙设备" || normalized(lead.business + " " + lead.emailFocus).includes(normalized(product))) &&
    (!market || normalized(lead.market).includes(normalized(market))) &&
    (!query.type || lead.type === query.type) &&
    (!query.days || lead.age <= Number(query.days)) &&
    normalized(Object.values(lead).join(" ") + " bakery equipment 商用烘焙设备").includes(normalized(query.keyword))
  );
  if (leads.some(lead => lead.name === samples[0][0])) {
    const duplicate = leads.find(lead => lead.name === samples[0][0]);
    leads.push({...duplicate, source: duplicate.website + "/about"});
  }
  return leads;
}
// Local browser repository. Replace this adapter with authenticated API calls
// when account-scoped persistence is introduced.
export const repository = {
  list() { return JSON.parse(localStorage.getItem(config.storageKey + storageNamespace) || "{}"); },
  setCloudAdapter(adapter) { cloudAdapter = adapter; },
  useUser(userId) { storageNamespace = userId ? ".user." + userId : ""; },
  isCloudUser() { return Boolean(storageNamespace); },
  async syncRecord(lead) {
    if (!cloudAdapter || !storageNamespace) return false;
    const key = leadKey(lead);
    const record = this.list()[key];
    if (!record) return false;
    const saved = await cloudAdapter.put(key, record);
    if (saved?.updated_at) {
      const records = this.list();
      records[key] = {...records[key], updatedAt:saved.updated_at};
      localStorage.setItem(config.storageKey + storageNamespace, JSON.stringify(records));
    }
    return true;
  },
  async syncCloud() {
    if (!cloudAdapter || !storageNamespace) return false;
    const key = config.storageKey + storageNamespace;
    const local = this.list();
    const remote = await cloudAdapter.list();
    for (const row of remote) {
      const current = local[row.record_key];
      if (!current || Date.parse(row.record.updatedAt || 0) >= Date.parse(current.updatedAt || 0)) {
        local[row.record_key] = row.record;
      }
    }
    localStorage.setItem(key, JSON.stringify(local));
    for (const [recordKey, record] of Object.entries(local)) {
      const remoteRecord = remote.find(row => row.record_key === recordKey)?.record;
      if (!remoteRecord || Date.parse(record.updatedAt || 0) > Date.parse(remoteRecord.updatedAt || 0)) {
        const saved = await cloudAdapter.put(recordKey, record);
        if (saved?.updated_at) local[recordKey] = {...local[recordKey], updatedAt:saved.updated_at};
      }
    }
    localStorage.setItem(key, JSON.stringify(local));
    return true;
  },
  put(lead, changes) {
    const records = this.list();
    const key = leadKey(lead);
    const current = records[key] || {saved:false, status:statuses[0], note:"", history:[]};
    const next = {...current, ...changes, lead, updatedAt:new Date().toISOString()};
    if (current.status !== next.status || current.note !== next.note) {
      next.history = [{status:next.status, note:next.note, at:new Date().toISOString()}, ...current.history];
    }
    records[key] = next;
    localStorage.setItem(config.storageKey + storageNamespace, JSON.stringify(records));
    return records;
  }
};
export function draftEmail(lead, product) {
  const focus = lead.emailFocus || "commercial bakery equipment";
  return (lead.sourceType === "demo" ? "【演示草稿 · 虚构客户】\n" : "") +
    "Subject: Zhengmai bakery equipment for " + lead.name + "\n\n" +
    "Hello " + lead.name + " team,\n\n" +
    "I'm Shelly from Zhengmai, a manufacturer of commercial bakery equipment. " +
    "I'm reaching out to see whether you are currently sourcing " + focus + ".\n\n" +
    "We supply equipment under the Zhengmai brand and can discuss OEM options for suitable models. " +
    "May I send you our catalog and a short list of models for your market? " +
    "If you share your preferred equipment categories and specifications, I can suggest suitable options.\n\n" +
    "Best regards,\nShelly\nZhengmai" +
    (product ? "\n\n【内部备注，发送前删除】本次搜索产品：" + product : "");
}
export function csvEncode(rows) {
  return "\uFEFF" + rows.map(row => row.map(value => {
    const valueText = String(value ?? "");
    const neutral = /^[\s]*[=+\-@]|^[\t\r\n]/.test(valueText) ? "'" + valueText : valueText;
    return '"' + neutral.replaceAll('"', '""') + '"';
  }).join(",")).join("\r\n");
}
