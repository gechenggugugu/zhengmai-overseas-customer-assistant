// Public client settings only. Never put provider credentials here.
const publicSettings = globalThis.ZHENGMAI_CONFIG || {};
const supabaseUrl = typeof publicSettings.supabaseUrl === "string" ? publicSettings.supabaseUrl.replace(/\/$/, "") : "";
export const config = Object.freeze({
  searchEndpoint: typeof publicSettings.searchEndpoint === "string" && publicSettings.searchEndpoint
    ? publicSettings.searchEndpoint
    : (supabaseUrl ? supabaseUrl + "/functions/v1/leads-search" : ""),
  supabaseUrl,
  supabaseAnonKey: typeof publicSettings.supabasePublishableKey === "string" ? publicSettings.supabasePublishableKey :
    (typeof publicSettings.supabaseAnonKey === "string" ? publicSettings.supabaseAnonKey : ""),
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
const aliases = {"my":"马来西亚","malaysia":"马来西亚","ae":"阿联酋","uae":"阿联酋","united arab emirates":"阿联酋","au":"澳大利亚","australia":"澳大利亚","vn":"越南","vietnam":"越南","sa":"沙特阿拉伯","saudi arabia":"沙特阿拉伯","commercial oven":"商用烤箱","dough mixer":"和面机","proofer":"醒发箱","bakery production line":"烘焙生产线","bakery equipment":"商用烘焙设备"};
export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
const normalized = value => String(value ?? "").trim().toLowerCase();
const newRequestId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new Error("当前浏览器无法安全生成搜索编号，请更新浏览器后重试。");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
let cloudAdapter = null;
let storageNamespace = "";
let cloudUserId = null;
let syncGeneration = 0;
const pendingWrites = new Map();

function captureSyncScope() {
  const generation = syncGeneration;
  return {adapter:cloudAdapter, userId:cloudUserId, key:config.storageKey + storageNamespace,
    current:() => generation === syncGeneration};
}

function readRecords(key) {
  return JSON.parse(localStorage.getItem(key) || "{}");
}

function writeCloudRecord(scope, key, remoteRecord) {
  const queueKey = JSON.stringify([scope.key, key]);
  const previous = pendingWrites.get(queueKey) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    if (!scope.current()) return false;
    const record = readRecords(scope.key)[key];
    if (!record) return false;
    if (remoteRecord && !record.pendingSync && Date.parse(record.updatedAt || 0) <= Date.parse(remoteRecord.updatedAt || 0)) return true;
    const saved = await scope.adapter.put(key, record, scope.userId);
    if (!scope.current()) return false;
    if (saved?.conflictRecord || saved?.updated_at) {
      const records = readRecords(scope.key);
      const current = records[key];
      const unchanged = JSON.stringify(current) === JSON.stringify(record);
      if (saved.conflictRecord) {
        if (current) {
          const {localConflict,pendingSync,syncRevision,...localEdit} = current;
          records[key] = {...saved.conflictRecord, localConflict:localEdit};
          localStorage.setItem(scope.key, JSON.stringify(records));
        }
        throw Object.assign(new Error("另一台电脑已更新此线索，请核对保留的本机备注。"), {code:"CLOUD_EDIT_CONFLICT"});
      }
      if (unchanged) {
        records[key] = {...record, updatedAt:saved.updated_at, syncRevision:saved.updated_at, pendingSync:false};
      } else if (current && current.syncRevision === record.syncRevision) {
        // The next queued edit was based on this device's just-saved record.
        records[key] = {...current, syncRevision:saved.updated_at};
      }
      localStorage.setItem(scope.key, JSON.stringify(records));
    }
    return true;
  });
  pendingWrites.set(queueKey, write);
  return write.finally(() => {
    if (pendingWrites.get(queueKey) === write) pendingWrites.delete(queueKey);
  });
}
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
const providerFailureMessages = {
  search_provider_not_configured:"搜索服务尚未完成配置，请联系管理员。",
  search_provider_http_error:"搜索供应商暂时拒绝了请求，请稍后重试。",
  search_provider_invalid_json:"搜索供应商返回了无法读取的数据，请稍后重试。",
  search_provider_invalid_response:"搜索供应商返回的数据格式无效，请稍后重试。",
  search_provider_timeout:"搜索供应商响应超时，请稍后重试。"
};

function searchError(message, requestId, failure) {
  const serverId = failure?.requestId;
  const trace = typeof serverId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(serverId)
    ? serverId : requestId;
  const settlement = failure?.quotaRefunded === true ? " 本次额度已退回。" :
    failure?.quotaRefunded === false ? " 额度结算尚未确认，请稍后刷新额度。" : "";
  return new Error(`${message}${settlement}（请求编号：${trace}）`);
}

async function postLiveSearch(body, signal, action) {
  const headers = {"Content-Type":"application/json"};
  if (config.supabaseAnonKey) headers.apikey = config.supabaseAnonKey;
  const token = await cloudAdapter?.accessToken?.();
  if (token) headers.Authorization = "Bearer " + token;
  const requestId = newRequestId();
  let response;
  try {
    response = await fetch(config.searchEndpoint, {
      method:"POST", headers, body:JSON.stringify({...body,requestId}), signal
    });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    throw searchError("搜索请求未收到响应。请检查网络并刷新额度后重试。",requestId);
  }
  if (response.ok) {
    try { return await response.json(); }
    catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      throw searchError("无法读取搜索结果，请刷新额度后重试。",requestId);
    }
  }
  const failure = await response.json().catch(() => null);
  const code = failure?.code || failure?.error;
  const reason = failure?.reason || failure?.quota?.reason;
  let message;
  if (response.status === 401) message = `登录验证错误：请先登录并验证邮箱后再${action}。`;
  else if (response.status === 404) message = "真实搜索端点尚不可用，请联系管理员检查部署。";
  else if (response.status === 429) {
    message = reason === "monthly" ? "配额不足：本月共享额度已用完。" :
      reason === "daily" ? "配额不足：今日个人额度已用完。" : "请求暂时受限，请检查额度后稍后重试。";
  } else if (response.status === 409) message = `相同${action}请求已处理或正在进行，请重新发起。`;
  else if (typeof code === "string" && Object.hasOwn(providerFailureMessages,code)) message = providerFailureMessages[code];
  else if (response.status >= 500) message = "搜索服务暂不可用，请刷新额度后稍后重试。";
  else message = `搜索请求未通过校验（HTTP ${response.status}）。`;
  throw searchError(message,requestId,failure);
}

export async function searchLeads(query, signal) {
  if (query.mode === "live") {
    if (!config.searchEndpoint) throw new Error("真实搜索尚未配置。请选择演示样本，或查看使用说明。");
    const payload = await postLiveSearch({...query,limit:config.maxResults},signal,"搜索");
    if (!Array.isArray(payload?.leads)) throw new Error("真实搜索返回格式不符合接口约定。");
    const leads = payload.leads.slice(0, config.maxResults).map(lead => ({
      name: String(lead.name ?? "").trim(), market: String(lead.market ?? ""),
      marketStatus: String(lead.marketStatus ?? "待核实"), type: String(lead.type ?? ""),
      typeStatus: String(lead.typeStatus ?? "待核实"), nameStatus: String(lead.nameStatus ?? "需确认公司主体"),
      websiteStatus: String(lead.websiteStatus ?? "搜索结果站点，尚未核实为公司官网"), business: String(lead.business ?? ""),
      website: safeUrl(lead.website), contact: String(lead.contact ?? ""),
      contactStatus: String(lead.contactStatus ?? (lead.contact ? "来源摘要发现 · 请人工核实" : "未获取")),
      matchScore: Number.isFinite(Number(lead.matchScore)) ? Number(lead.matchScore) : null,
      emailDraft: String(lead.emailDraft ?? "").slice(0, 5000),
      reason: String(lead.reason ?? ""), source: safeUrl(lead.source),
      date: String(lead.date ?? ""), emailFocus: "", sourceType: "live"
    })).filter(lead => lead.name && lead.source);
    Object.defineProperty(leads, "providerUsage", {value:payload.usage || null, enumerable:false});
    return leads;
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
export async function searchCompanyContacts(lead, signal) {
  if (lead.sourceType !== "live") throw new Error("演示样本不支持真实联系人挖掘。");
  if (!config.searchEndpoint) throw new Error("真实搜索尚未配置。");
  const payload = await postLiveSearch({
    action:"contacts", company:{name:lead.name,website:lead.website,market:lead.market}
  },signal,"搜索联系人");
  if (!Array.isArray(payload?.contacts)) throw new Error("联系人搜索返回格式不符合接口约定。");
  return payload;
}
// Local browser repository. Replace this adapter with authenticated API calls
// when account-scoped persistence is introduced.
export const repository = {
  list() { return readRecords(config.storageKey + storageNamespace); },
  setCloudAdapter(adapter) {
    if (cloudAdapter !== adapter) syncGeneration++;
    cloudAdapter = adapter;
  },
  useUser(userId) {
    const nextUserId = userId || null;
    if (cloudUserId !== nextUserId) syncGeneration++;
    cloudUserId = nextUserId;
    storageNamespace = nextUserId ? ".user." + nextUserId : "";
  },
  isCloudUser() { return Boolean(storageNamespace); },
  guestRecords() { try { return JSON.parse(localStorage.getItem(config.storageKey) || "{}"); } catch { return {}; } },
  async importGuestRecords() {
    if (!storageNamespace) throw new Error("请先登录云端账号。");
    const guest = this.guestRecords();
    const current = this.list();
    for (const [key, record] of Object.entries(guest)) {
      if (!current[key]) current[key] = record;
      else if (Date.parse(record.updatedAt || 0) > Date.parse(current[key].updatedAt || 0)) current[key] = record;
    }
    localStorage.setItem(config.storageKey + storageNamespace, JSON.stringify(current));
    return await this.syncCloud() ? Object.keys(guest).length : null;
  },
  async syncRecord(lead) {
    if (!cloudAdapter || !storageNamespace) return false;
    return writeCloudRecord(captureSyncScope(), leadKey(lead));
  },
  async syncCloud() {
    if (!cloudAdapter || !storageNamespace) return false;
    const scope = captureSyncScope();
    const remote = await scope.adapter.list(scope.userId);
    if (!scope.current()) return false;
    const local = readRecords(scope.key);
    const remoteByKey = new Map();
    for (const row of remote) {
      remoteByKey.set(row.record_key, row.record);
      const current = local[row.record_key];
      if (!current || (!current.pendingSync && Date.parse(row.record.updatedAt || 0) >= Date.parse(current.updatedAt || 0))) {
        local[row.record_key] = current?.localConflict ? {...row.record, localConflict:current.localConflict} : row.record;
      }
    }
    localStorage.setItem(scope.key, JSON.stringify(local));
    for (const recordKey of Object.keys(local)) {
      if (!await writeCloudRecord(scope, recordKey, remoteByKey.get(recordKey))) return false;
    }
    return scope.current();
  },
  put(lead, changes) {
    const records = this.list();
    const key = leadKey(lead);
    const current = records[key] || {saved:false, status:statuses[0], note:"", history:[]};
    const next = {...current, ...changes, lead, updatedAt:new Date().toISOString(), pendingSync:this.isCloudUser()};
    if ("note" in changes || "status" in changes) delete next.localConflict;
    if (current.status !== next.status || current.note !== next.note) {
      next.history = [{status:next.status, note:next.note, at:new Date().toISOString()}, ...current.history];
    }
    records[key] = next;
    localStorage.setItem(config.storageKey + storageNamespace, JSON.stringify(records));
    return records;
  }
};
export function draftEmail(lead, product) {
  if (lead.emailDraft) return lead.emailDraft;
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
