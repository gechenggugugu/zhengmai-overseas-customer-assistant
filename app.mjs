import {config, statuses, searchLeads, searchCompanyContacts, uniqueLeads, leadKey, repository, draftEmail, csvEncode, safeUrl} from "./services.mjs";
import {createCloudStore} from "./cloud-storage.mjs";
const markets = await fetch("./backend/supabase/functions/_shared/markets.json", {cache:"force-cache"}).then(response => {
  if (!response.ok) throw new Error("market_config_unavailable");
  return response.json().then(items => items.sort((left, right) => left.zh.localeCompare(right.zh, "zh-CN")));
});
const $ = id => document.getElementById(id);
const form = $("search-form");
const dialog = $("details");
const state = {page:"search", mode:"demo", results:[], records:{}, product:"", quota:null, quotaError:"", providerUsage:null, searchStatus:"idle", searchError:""};
let activeSearch, toastTimer;
let cloudSessionGeneration = 0;
let currentCloudUserId = null;
let searchGeneration = 0;
let searchInFlight = false;
let authRequestInFlight = false;
let contactSearchController;
const cloud = createCloudStore(config);
repository.setCloudAdapter(cloud);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const sourceName = lead => lead.sourceType === "demo" ? "模拟样本" : "真实搜索";
const badge = lead => '<span class="badge ' + esc(lead.sourceType) + '">' + sourceName(lead) + '</span>';
const recordFor = lead => state.records[leadKey(lead)] || {status:statuses[0], saved:false, note:"", history:[]};
const options = selected => statuses.map(status => '<option' + (status === selected ? ' selected' : '') + '>' + status + '</option>').join("");
const marketLabels = {AE:"阿联酋"};
const marketName = market => marketLabels[market.code] || market.zh;
const marketOption = market => '<option value="' + esc(market.code) + '">' + esc(marketName(market)) + ' · ' + esc(market.en) + ' (' + esc(market.code) + ')</option>';
function populateMarkets(search = "") {
  const select = $("market-list");
  const chosen = select.value;
  const term = search.trim().toLocaleLowerCase();
  const matches = markets.filter(market => !term || [market.code, market.zh, market.en, ...(market.aliases || [])].some(value => value.toLocaleLowerCase().includes(term)));
  const selected = markets.find(market => market.code === chosen);
  if (selected && !matches.includes(selected)) matches.unshift(selected);
  select.innerHTML = '<option value="">全部市场（全球搜索）</option>' + matches.map(marketOption).join("");
  select.value = chosen;
}
const link = (value, lead) => safeUrl(value)
  ? (lead.sourceType === "demo" ? esc(value) : '<a href="' + esc(safeUrl(value)) + '" target="_blank" rel="noopener noreferrer">' + esc(value) + '</a>')
  : "未获取";
function notify(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3500);
}
try { state.records = repository.list(); } catch { notify("读取本地记录失败。"); }
$("status-filter").insertAdjacentHTML("beforeend", options(""));
if (config.searchEndpoint) $("live-option").textContent = "真实搜索";
populateMarkets();
$("market-search").oninput = event => {
  $("market-list").value = "";
  populateMarkets(event.target.value);
};
$("market-list").onchange = event => {
  const market = markets.find(item => item.code === event.target.value);
  if (market) $("market-search").value = marketName(market);
  else $("market-search").value = "";
  populateMarkets($("market-search").value);
};
for (const button of document.querySelectorAll("[data-market]")) button.onclick = () => {
  const market = markets.find(item => item.code === button.dataset.market);
  if (!market) return;
  $("market-search").value = marketName(market);
  $("market-list").value = market.code;
  populateMarkets($("market-search").value);
};
function visibleLeads() {
  const query = $("filter").value.trim().toLowerCase();
  const status = $("status-filter").value;
  let leads = state.page === "search" ? state.results : Object.values(state.records)
    .filter(record => state.page === "saved" ? record.saved : record.history.length)
    .map(record => record.lead);
  if ($("dedupe").checked) leads = uniqueLeads(leads);
  return leads.filter(lead =>
    (!status || recordFor(lead).status === status) &&
    [lead.name,lead.market,lead.business,lead.type,lead.contact].join(" ").toLowerCase().includes(query)
  );
}
function showSyncConflict(error) {
  if (error?.code !== "CLOUD_EDIT_CONFLICT") return false;
  state.records = repository.list();
  render();
  $("cloud-state").textContent = "有跟进记录需要核对";
  notify(error.message);
  return true;
}

function updateRecord(lead, fields) {
  try {
    state.records = repository.put(lead, fields);
    render();
    if (repository.isCloudUser()) {
      const generation = cloudSessionGeneration;
      repository.syncRecord(lead).then(synced => {
        if (!synced || generation !== cloudSessionGeneration) return;
        $("cloud-state").textContent = "已同步";
      }).catch(error => {
        if (generation !== cloudSessionGeneration) return;
        if (showSyncConflict(error)) return;
        $("cloud-state").textContent = "本机已保存，云同步失败";
        notify("本机已保存；云端同步失败，请检查网络或账号状态。稍后登录可重试同步。");
      });
    }
    return true;
  } catch {
    notify("保存失败，请检查浏览器是否允许本地存储。");
    return false;
  }
}

async function applyCloudSession(session) {
  const generation = ++cloudSessionGeneration;
  const nextUserId = session?.user?.id || null;
  if (currentCloudUserId !== nextUserId) {
    currentCloudUserId = nextUserId;
    activeSearch?.abort();
    contactSearchController?.abort();
    if (dialog.open) dialog.close();
    if (state.mode === "live") state.results = [];
    state.providerUsage = null;
  }
  repository.useUser(nextUserId);
  state.quota = null;
  state.quotaError = "";
  state.records = repository.list();
  $("cloud-signout").hidden = !session;
  $("cloud-signup").hidden = Boolean(session);
  const hasGuestRecords = Object.keys(repository.guestRecords()).length > 0;
  $("guest-import-note").hidden = !session || !hasGuestRecords;
  $("guest-import").hidden = !session || !hasGuestRecords;
  $("cloud-state").textContent = session ? "同步中…" : "未登录";
  render();
  let synced = !session;
  if (session) {
    await refreshQuota(generation);
    if (generation !== cloudSessionGeneration) return false;
    try {
      const completed = await repository.syncCloud();
      if (!completed || generation !== cloudSessionGeneration) return false;
      state.records = repository.list();
      $("cloud-state").textContent = "已同步 · " + (session.user.email || "已登录");
      synced = true;
    } catch (error) {
      if (generation !== cloudSessionGeneration) return false;
      if (!showSyncConflict(error)) $("cloud-state").textContent = "已登录 · 云同步失败";
    }
  }
  render();
  return synced;
}

async function refreshQuota(generation = cloudSessionGeneration) {
  if (!repository.isCloudUser() || !cloud.isConfigured()) {
    state.quota = null;
    state.quotaError = "";
    renderQuota();
    return;
  }
  try {
    const quota = await cloud.getQuotaStatus();
    if (generation !== cloudSessionGeneration) return;
    state.quota = quota;
    state.quotaError = "";
  } catch {
    if (generation !== cloudSessionGeneration) return;
    state.quota = null;
    state.quotaError = "配额状态暂不可读取，请检查登录状态或稍后重试。";
  }
  renderQuota();
}

function renderQuota() {
  const panel = $("quota-panel");
  const adminForm = $("quota-admin-form");
  const visible = repository.isCloudUser() && Boolean(config.searchEndpoint);
  panel.hidden = !visible;
  if (!visible) return;
  const quota = state.quota;
  $("quota-admin-form").hidden = !quota?.is_admin;
  $("shelly-user-form").hidden = !quota?.is_admin;
  if (quota?.is_admin) {
    adminForm.elements.namedItem("monthlyLimit").value = quota.monthly_limit;
    $("shelly-config-status").textContent = quota.shelly_user_configured
      ? "已配置 Shelly UUID：" + (quota.shelly_user_id || "仅管理员可见")
      : "尚未配置；不会向任何用户开放每日无限额度。请从 Supabase Auth 用户列表复制实际 UUID。";
  }
  if (!quota) {
    $("quota-summary").textContent = state.quotaError || "正在读取配额…";
    $("quota-details").replaceChildren();
    return;
  }
  $("quota-summary").textContent = "今日 " + quota.today_used + " 次" +
    (quota.daily_unlimited ? "（每日不限）" : "，剩余 " + quota.today_remaining + " 次") +
    "；本月全项目已用 " + quota.month_used + " 次，剩余 " + quota.month_remaining + " 次";
  const reset = value => value ? new Date(value).toLocaleString("zh-CN", {timeZone:"UTC", timeZoneName:"short"}) : "待获取";
  $("quota-details").innerHTML = [
    "今日已用 " + quota.today_used + " 次",
    quota.daily_unlimited ? "今日剩余 不限" : "今日剩余 " + quota.today_remaining + " 次（上限 " + quota.daily_limit + "）",
    "本月已用 " + quota.month_used + " / " + quota.monthly_limit + " 次",
    "本月剩余 " + quota.month_remaining + " 次（全项目共享）",
    "今日重置 " + reset(quota.daily_resets_at),
    "本月重置 " + reset(quota.monthly_resets_at),
    state.providerUsage ? (state.providerUsage.cacheHit ? "本次命中缓存；未新增供应商 Credits" :
      "本次 API Credits：" + (Number.isInteger(state.providerUsage.apiCredits) ? state.providerUsage.apiCredits : "供应商未提供可核验用量")) : "API Credits：完成一次真实搜索后显示供应商返回值",
    "额度按 UTC 时间重置；搜索过程中暂时占用，失败或取消后退还。"
  ].map(value => "<span>" + esc(value) + "</span>").join("");
}

async function refreshCloudRecords() {
  if (!repository.isCloudUser()) return;
  const generation = cloudSessionGeneration;
  try {
    const completed = await repository.syncCloud();
    if (!completed || generation !== cloudSessionGeneration) return;
    state.records = repository.list();
    $("cloud-state").textContent = "已同步";
    render();
  } catch (error) {
    if (generation !== cloudSessionGeneration) return;
    if (!showSyncConflict(error)) $("cloud-state").textContent = "云同步暂不可用";
  }
  await refreshQuota(generation);
}

if (cloud.isConfigured()) {
  $("cloud-panel").hidden = false;
  async function runAuthAction(button, pendingText, pendingStatus, failureStatus, action) {
    if (authRequestInFlight) return;
    authRequestInFlight = true;
    const submitButton = $("cloud-auth-form").querySelector('[type="submit"]');
    const signupButton = $("cloud-signup");
    const previousText = button.textContent;
    submitButton.disabled = signupButton.disabled = true;
    button.textContent = pendingText;
    $("cloud-state").textContent = pendingStatus;
    try { await action(); }
    catch {
      $("cloud-state").textContent = failureStatus;
      notify(failureStatus);
    }
    finally {
      button.textContent = previousText;
      submitButton.disabled = signupButton.disabled = false;
      authRequestInFlight = false;
    }
  }
  $("cloud-auth-form").onsubmit = async event => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submitButton = event.submitter || event.currentTarget.querySelector('[type="submit"]');
    await runAuthAction(submitButton, "正在登录…", "正在登录…", "登录失败，请检查邮箱和密码后重试。", async () => {
      const session = await cloud.signIn(String(formData.get("email")).trim(), String(formData.get("password")));
      const synced = await applyCloudSession(session);
      notify(synced ? "云端登录成功，客户记录已同步。" : "已登录，但云端同步未完成，请检查数据库配置。");
    });
  };
  $("cloud-signup").onclick = async event => {
    const formData = new FormData($("cloud-auth-form"));
    const email = String(formData.get("email") || "").trim();
    const password = String(formData.get("password") || "");
    if (!email || password.length < 8) { notify("请填写邮箱和至少 8 位密码。"); return; }
    await runAuthAction(event.currentTarget, "正在创建…", "正在创建云端账号…", "账号创建失败，请检查邮箱后重试。", async () => {
      const session = await cloud.signUp(email, password);
      if (session) {
        const synced = await applyCloudSession(session);
        notify(synced ? "云端账号已创建并登录。" : "账号已创建，但云端同步未完成，请检查数据库配置。");
      } else {
        $("cloud-state").textContent = "等待邮箱验证";
        notify("账号申请已提交，请按邮件提示完成验证后登录。");
      }
    });
  };
  $("cloud-signout").onclick = async () => {
    try { await cloud.signOut(); } finally { await applyCloudSession(null); }
  };
  $("guest-import").onclick = async () => {
    const generation = cloudSessionGeneration;
    try {
      const count = await repository.importGuestRecords();
      if (count === null || generation !== cloudSessionGeneration) return;
      state.records = repository.list(); render();
      notify(`已将 ${count} 条本机记录合并到当前账号。`);
      $("guest-import-note").hidden = $("guest-import").hidden = true;
    } catch {
      if (generation === cloudSessionGeneration) notify("导入失败，请检查账号登录和云端连接后重试。");
    }
  };
  const restoreGeneration = cloudSessionGeneration;
  cloud.restoreSession().then(session => {
    if (restoreGeneration === cloudSessionGeneration) return applyCloudSession(session);
  }).catch(() => {
    if (restoreGeneration !== cloudSessionGeneration) return;
    $("cloud-state").textContent = "登录状态暂不可恢复，请重新登录";
    return applyCloudSession(null);
  });
  setInterval(() => {
    if (document.visibilityState === "visible") refreshCloudRecords();
  }, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshCloudRecords();
  });
} else {
  $("cloud-panel").hidden = true;
}
function render() {
  $("search-panel").hidden = state.page !== "search";
  const searchFeedback = $("search-feedback");
  const showSearchFeedback = state.page === "search" && ["loading","error","cancelled"].includes(state.searchStatus);
  searchFeedback.hidden = !showSearchFeedback;
  searchFeedback.dataset.state = state.searchStatus;
  searchFeedback.textContent = state.searchStatus === "loading" ? "正在搜索线索，请稍候…" :
    state.searchStatus === "cancelled" ? "搜索已取消，可以调整条件后重新搜索。" : state.searchError;
  $("results-panel").setAttribute("aria-busy", state.searchStatus === "loading" ? "true" : "false");
  $("search-button").disabled = searchInFlight;
  $("search-button").textContent = searchInFlight ? "正在搜索…" : "搜索客户";
  renderQuota();
  $("workspace-mode").textContent = state.page === "search"
    ? (state.mode === "live" ? "真实搜索" : "演示模式")
    : (repository.isCloudUser() ? "云端记录" : "本机记录");
  $("workspace-storage-label").textContent = repository.isCloudUser()
    ? "云端账号" : (cloud.isConfigured() ? "未登录" : "演示工作区");
  $("workspace-storage-detail").textContent = repository.isCloudUser()
    ? "同步状态见上方账户面板" : "记录保存在当前浏览器";
  $("view-title").textContent = {search:"搜索结果", saved:"我的收藏", follow:"跟进记录"}[state.page];
  for (const button of document.querySelectorAll("[data-page]")) {
    if (button.dataset.page === state.page) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  const mode = state.page === "search" ? state.mode : "records";
  $("mode-note").dataset.mode = mode;
  $("mode-note").textContent = {
    demo:"演示样本 · 公司、联系方式和 .example 链接均为模拟，供体验操作。",
    live:config.searchEndpoint ? "真实搜索 · 请查看各条线索的公开来源。" : "真实搜索尚未配置，请切换到演示样本。",
    records:repository.isCloudUser()
      ? "云端账号记录 · 已登录账号的收藏和跟进会与其他已登录设备同步。"
      : "本机记录 · 每条线索均标有来源类型，收藏和跟进仅保存在当前浏览器。"
  }[mode];
  const leads = visibleLeads();
  const removed = state.page === "search" && $("dedupe").checked ? state.results.length - uniqueLeads(state.results).length : 0;
  $("count").textContent = "显示 " + leads.length + " 条线索" + (removed ? " · 已合并 " + removed + " 条重复结果" : "");
  $("export").disabled = leads.length === 0;
  const hasFilters = Boolean($("filter").value.trim() || $("status-filter").value);
  let emptyMessage = "没有符合当前条件的线索。";
  if (state.page === "search") {
    if (state.searchStatus === "loading") emptyMessage = "正在搜索，请稍候…";
    else if (state.searchStatus === "error") emptyMessage = "本次搜索未完成，请查看上方提示后重试。";
    else if (state.searchStatus === "cancelled") emptyMessage = "搜索已取消，可以调整条件后重新搜索。";
    else if (hasFilters) emptyMessage = "没有符合当前筛选条件的线索，请调整筛选条件。";
    else emptyMessage = "没有找到符合条件的线索，可以调整产品、国家或关键词后重试。";
  } else if (hasFilters) emptyMessage = "没有符合当前筛选条件的线索，请调整筛选条件。";
  else if (state.page === "saved") emptyMessage = "还没有收藏线索。回到客户搜索，把合适的线索加入收藏。";
  else emptyMessage = "还没有跟进记录。打开线索详情，填写跟进状态或备注后保存。";
  $("rows").innerHTML = leads.map((lead, index) => {
    const record = recordFor(lead);
    return '<tr><td data-label="公司与官网"><strong>' + esc(lead.name) + '</strong><small>' + link(lead.website, lead) + '</small><small>' + badge(lead) +
      '</small></td><td data-label="国家 / 地区">' + esc(lead.market || "未获取") + '</td><td data-label="客户类型与主营">' + esc(lead.type || "待核实") + '<small>' + esc(lead.business || "未获取") +
      '</small></td><td data-label="跟进状态"><span class="badge">' + esc(record.status) + '</span></td><td class="row-actions" data-label="操作">' +
      '<button data-detail="' + index + '">详情</button><button data-save="' + index + '" aria-pressed="' + record.saved + '">' +
      (record.saved ? "已收藏" : "收藏") + '</button></td></tr>';
  }).join("") || '<tr><td colspan="5" class="empty" role="status">' + esc(emptyMessage) + '</td></tr>';
  $("rows").onclick = event => {
    const button = event.target.closest("button");
    if (!button) return;
    const lead = leads[Number(button.dataset.detail ?? button.dataset.save)];
    if (button.dataset.detail !== undefined) showDetail(lead);
    else if (updateRecord(lead, {saved:!recordFor(lead).saved})) notify(recordFor(lead).saved ? "已收藏" : "已取消收藏");
  };
}

$("quota-admin-form").onsubmit = async event => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const monthlyLimit = Number(formData.get("monthlyLimit"));
  if (!Number.isInteger(monthlyLimit) || monthlyLimit < 1 || monthlyLimit > 1000) {
    notify("月度共享额度范围无效：1–1000。");
    return;
  }
  try {
    state.quota = await cloud.setQuotaLimits(monthlyLimit);
    state.quotaError = "";
    renderQuota();
    notify("管理员配额已更新。");
  } catch {
    notify("配额更新失败：当前账号未获管理员授权或请求暂不可用。");
  }
};
$("shelly-user-form").onsubmit = async event => {
  event.preventDefault();
  const userId = String(new FormData(event.currentTarget).get("userId") || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    notify("请填写 Supabase Auth 用户列表中的完整 UUID。"); return;
  }
  try { state.quota = await cloud.setShellyUser(userId); await refreshQuota(); notify("Shelly UUID 授权已更新。"); }
  catch { notify("授权失败：当前账号未获管理员授权，或该 UUID 不存在。"); }
};
$("clear-shelly-user").onclick = async () => {
  try { state.quota = await cloud.setShellyUser(null); await refreshQuota(); notify("Shelly 每日无限额度已取消。"); }
  catch { notify("取消授权失败：当前账号未获管理员授权。"); }
};
function showDetail(lead) {
  const record = recordFor(lead);
  $("detail-title").textContent = lead.name;
  const fields = [
    ["数据来源",badge(lead)], ["公司名称核实",esc(lead.nameStatus || "需确认公司主体")],
    ["国家 / 地区",esc(lead.market || "待核实") + " · " + esc(lead.marketStatus || "待核实")],
    ["客户类型",esc(lead.type || "待核实") + " · " + esc(lead.typeStatus || "待核实")],
    ["主营业务 / 搜索摘要",esc(lead.business)], ["搜索结果站点",link(lead.website, lead) + " · " + esc(lead.websiteStatus || "尚未核实为公司官网")], ["联系方式",esc(lead.contact || "未获取")],
    ["联系方式核实",esc(lead.contactStatus || (lead.contact ? "请人工核实" : "未获取"))],
    ["匹配理由",esc(lead.reason || "未获取")], ["来源链接",link(lead.source, lead)],
    [lead.sourceType === "demo" ? "模拟来源日期" : "来源日期",esc(lead.date || "未获取")]
  ];
  const contactBlock = '<section class="contact-panel"><div class="section-heading"><div><h3>企业关键联系人</h3><p>采购负责人优先，同时查找公司老板与决策人。结果仅作线索，须核对来源。</p></div><button class="primary" id="find-contacts" ' + (lead.sourceType === "live" ? "" : "disabled") + '>按需挖掘</button></div>' +
    (lead.sourceType !== "live" ? '<p class="contact-empty">演示公司为虚构样本，不能进行真实联系人搜索。</p>' : "") +
    (record.contactSearchError ? '<p class="contact-empty">' + esc(record.contactSearchError) + '</p>' : "") +
    (record.contacts?.length ? '<div class="contact-list">' + record.contacts.map((contact,index) => '<article class="contact-card"><div><strong>' + esc(contact.name || "姓名未识别") + '</strong><span class="badge">' + esc(contact.target || "联系人") + '</span></div><p>' + esc(contact.position || "职位待核实") + ' · ' + esc(contact.country || "国家待核实") + '</p><p>匹配度 ' + esc(contact.matchScore) + '/100 · ' + esc(contact.verificationStatus || "待核实") + '</p><p>' + (contact.socialUrl ? link(contact.socialUrl,lead) : "未找到公开 LinkedIn / Facebook 主页") + (contact.email ? ' · ' + esc(contact.email) : "") + (contact.phone ? ' · ' + esc(contact.phone) : "") + '</p><p>证据来源：' + link(contact.evidenceSource,lead) + '</p><small>' + esc(contact.evidence || "") + '</small><div class="contact-verify"><button data-contact-verify="' + index + '" data-status="' + (contact.verificationStatus === "已核实" ? "待核实" : "已核实") + '">' + (contact.verificationStatus === "已核实" ? "恢复待核实" : "人工核实后标记已核实") + '</button></div></article>').join("") + '</div>' : '<p class="contact-empty">' + (record.contactsSearchedAt ? (record.contactSearchStatus === "未找到" ? "未找到有证据的联系人。" : "联系人待核实。") + ' 搜索时间：' + esc(new Date(record.contactsSearchedAt).toLocaleString("zh-CN")) : "尚未挖掘。") + '</p>') + '</section>';
  $("detail-body").innerHTML = '<div class="detail-grid">' + fields.map(([key,value]) => '<div><b>' + key + '</b>' + value + '</div>').join("") + '</div>' + contactBlock +
    (record.localConflict ? '<section class="panel"><b>另一台电脑已更新此线索</b><p>以下修改保留在本机。核对后，可以将需要的内容填回并保存。</p><p>本机状态：' +
      esc(record.localConflict.status || "—") + ' · 本机备注：' + esc(record.localConflict.note || "无备注") + '</p></section>' : "") +
    '</div><label>跟进状态<select id="detail-status">' + options(record.status) + '</select></label>' +
    '<label style="margin-top:10px">跟进备注<textarea id="detail-note" placeholder="记录沟通内容或下一步行动">' + esc(record.note) + '</textarea></label>' +
    '<div class="actions"><button class="primary" id="save-follow">保存跟进</button><button id="draft">生成首次开发邮件</button></div>' +
    '<div id="draft-area" hidden><label>英文邮件草稿<textarea rows="10" id="draft-text"></textarea></label><div class="actions"><button id="copy">复制草稿</button></div></div>' +
    '<details><summary>跟进历史（' + record.history.length + '）</summary>' +
    record.history.map(entry => '<p>' + esc(new Date(entry.at).toLocaleString("zh-CN")) + ' · ' + esc(entry.status) + ' · ' + esc(entry.note || "无备注") + '</p>').join("") + '</details>';
  $("save-follow").onclick = () => {
    if (updateRecord(lead, {status:$("detail-status").value,note:$("detail-note").value.trim()})) {
      notify("跟进记录已保存");
      const draft = $("draft-area").hidden ? null : $("draft-text").value;
      showDetail(lead);
      if (draft !== null) { $("draft-text").value = draft; $("draft-area").hidden = false; }
    }
  };
  $("find-contacts").onclick = async () => {
    const button = $("find-contacts");
    contactSearchController?.abort();
    const request = contactSearchController = new AbortController();
    button.disabled = true; button.textContent = "正在搜索…";
    try {
      const result = await searchCompanyContacts(lead, request.signal);
      state.providerUsage = result.usage || null;
      if (request.signal.aborted) return;
      const previous = recordFor(lead).contacts || [];
      const priorByIdentity = new Map(previous.map(contact => [contact.name + "|" + contact.position, contact]));
      const contacts = result.contacts.length ? result.contacts.map(contact => {
        const prior = priorByIdentity.get(contact.name + "|" + contact.position);
        return prior?.verificationStatus === "已核实" ? {...contact, verificationStatus:"已核实", verifiedAt:prior.verifiedAt} : contact;
      }) : previous;
      updateRecord(lead, {contacts, contactsSearchedAt:result.searchedAt, contactSearchStatus:contacts.length ? "待核实" : "未找到", lastContactSearchFound:result.contacts.length, contactSearchError:""});
      showDetail(lead);
      notify(result.contacts.length ? `找到 ${result.contacts.length} 条联系人线索。` : previous.length ? "本次未找到新联系人，已保留此前记录。" : "搜索完成，未找到有来源证据的联系人。");
    } catch (error) {
      if (!request.signal.aborted) {
        updateRecord(lead, {contactSearchError:error.message});
        showDetail(lead);
        notify(error.message);
      }
    } finally {
      await refreshQuota();
    }
  };
  $("detail-body").querySelectorAll("[data-contact-verify]").forEach(button => button.onclick = () => {
    const contacts = [...(recordFor(lead).contacts || [])];
    const index = Number(button.dataset.contactVerify);
    if (!contacts[index]) return;
    contacts[index] = {...contacts[index], verificationStatus:button.dataset.status, verifiedAt:button.dataset.status === "已核实" ? new Date().toISOString() : ""};
    updateRecord(lead, {contacts});
    showDetail(lead);
  });
  $("draft").onclick = () => {
    $("draft-text").value = draftEmail(lead, state.page === "search" ? state.product : "");
    $("draft-area").hidden = false;
    $("draft-text").focus();
  };
  $("copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("draft-text").value); notify("已复制邮件草稿"); }
    catch { $("draft-text").select(); notify("请按 Ctrl+C 复制选中的草稿。"); }
  };
  if (!dialog.open) dialog.showModal();
}
$("close").onclick = () => dialog.close();
for (const button of document.querySelectorAll("[data-page]")) button.onclick = () => {
  if (state.page === "search" && button.dataset.page !== "search" && searchInFlight) cancelActiveSearch();
  state.page = button.dataset.page;
  $("filter").value = $("status-filter").value = "";
  render();
};
$("filter").oninput = $("status-filter").onchange = $("dedupe").onchange = render;
function fillExample() {
  Object.entries({product:"商用烘焙设备",market:"",type:"",keyword:"bakery equipment",days:"",mode:"demo"})
    .forEach(([key,value]) => { form.elements.namedItem(key).value = value; });
}
$("example").onclick = () => {
  fillExample();
  form.requestSubmit();
};
function cancelActiveSearch() {
  const wasInFlight = searchInFlight;
  searchGeneration++;
  activeSearch?.abort();
  activeSearch = undefined;
  searchInFlight = false;
  state.searchStatus = wasInFlight ? "cancelled" : "idle";
  state.searchError = "";
  $("search-button").disabled = false;
  $("search-button").textContent = "搜索客户";
}
form.elements.namedItem("mode").onchange = () => {
  cancelActiveSearch();
  state.results = [];
  state.mode = form.elements.namedItem("mode").value;
  render();
};
form.onreset = () => {
  cancelActiveSearch();
  state.results = [];
  state.mode = "demo";
  state.searchStatus = "idle";
  state.searchError = "";
  state.product = "";
  $("filter").value = $("status-filter").value = "";
  render();
};
form.onsubmit = async event => {
  event.preventDefault();
  if (searchInFlight) return;
  const query = Object.fromEntries([...new FormData(form)].map(([key,value]) => [key, value.trim()]));
  if (!query.product) { notify("请输入产品名称。"); form.elements.namedItem("product").focus(); return; }
  const request = new AbortController();
  const requestGeneration = ++searchGeneration;
  activeSearch = request;
  searchInFlight = true;
  state.mode = query.mode;
  state.searchStatus = "loading";
  state.searchError = "";
  state.providerUsage = null;
  state.product = query.product;
  state.results = [];
  $("filter").value = $("status-filter").value = "";
  render();
  try {
    const leads = await searchLeads(query, request.signal);
    if (request.signal.aborted || activeSearch !== request || searchGeneration !== requestGeneration) return;
    state.results = leads;
    state.searchStatus = "success";
    state.providerUsage = leads.providerUsage;
    render();
    if (state.page === "search" && event.submitter) notify("搜索完成，找到 " + visibleLeads().length + " 条线索");
  } catch (error) {
    if (request.signal.aborted || activeSearch !== request || searchGeneration !== requestGeneration) return;
    state.searchStatus = "error";
    state.searchError = error.message || "搜索服务暂不可用，请稍后重试。";
    render();
  } finally {
    const isCurrentSearch = activeSearch === request && searchGeneration === requestGeneration;
    if (isCurrentSearch) {
      activeSearch = undefined;
      searchInFlight = false;
      $("search-button").disabled = false;
      $("search-button").textContent = "搜索客户";
    }
    if (isCurrentSearch && query.mode === "live") {
      try { await refreshQuota(); } catch { /* Quota refresh must not affect search controls. */ }
    }
  }
};
$("export").onclick = () => {
  const headers = ["数据类型","公司名称","官网","国家/地区","客户类型","主营业务","联系方式","匹配理由","来源链接","来源日期","联系人姓名","联系人职位","联系人公开主页","联系人公开商务邮箱","联系人核实状态","联系人证据来源","收藏","跟进状态","跟进备注"];
  const leads = visibleLeads();
  const rows = leads.map(lead => {
    const record = recordFor(lead);
    const contacts = record.contacts || [];
    return [sourceName(lead),lead.name,lead.website,lead.market,lead.type,lead.business,lead.contact,lead.reason,lead.source,lead.date,
      ...["name","position","socialUrl","email","verificationStatus","evidenceSource"].map(key => contacts.map(contact => contact[key] || "").join("\n")),
      record.saved ? "是" : "否",record.status,record.note];
  });
  const url = URL.createObjectURL(new Blob([csvEncode([headers,...rows])], {type:"text/csv;charset=utf-8"}));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "正麦客户线索-" + (leads.every(l => l.sourceType === "demo") ? "模拟样本" : "按数据类型区分") + ".csv";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify("已导出当前筛选结果");
};
fillExample();
$("search-button").disabled = false;
$("startup-note").hidden = true;
form.requestSubmit();
