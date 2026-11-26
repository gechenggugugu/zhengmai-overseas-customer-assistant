import {config, statuses, searchLeads, uniqueLeads, leadKey, repository, draftEmail, csvEncode, safeUrl} from "./services.mjs";
import {createCloudStore} from "./cloud-storage.mjs";
const markets = await fetch("./backend/supabase/functions/_shared/markets.json", {cache:"force-cache"}).then(response => {
  if (!response.ok) throw new Error("market_config_unavailable");
  return response.json().then(items => items.sort((left, right) => left.zh.localeCompare(right.zh, "zh-CN")));
});
const $ = id => document.getElementById(id);
const form = $("search-form");
const dialog = $("details");
const state = {page:"search", mode:"demo", results:[], records:{}, product:""};
let activeSearch, toastTimer;
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
function updateRecord(lead, fields) {
  try {
    state.records = repository.put(lead, fields);
    render();
    if (repository.isCloudUser()) {
      repository.syncRecord(lead).then(() => {
        $("cloud-state").textContent = "已同步";
      }).catch(() => {
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
  repository.useUser(session?.user?.id || null);
  state.records = repository.list();
  $("cloud-signout").hidden = !session;
  $("cloud-signup").hidden = Boolean(session);
  const hasGuestRecords = Object.keys(repository.guestRecords()).length > 0;
  $("guest-import-note").hidden = !session || !hasGuestRecords;
  $("guest-import").hidden = !session || !hasGuestRecords;
  $("cloud-state").textContent = session ? "同步中…" : "未登录";
  let synced = !session;
  if (session) {
    try {
      await repository.syncCloud();
      state.records = repository.list();
      $("cloud-state").textContent = "已同步 · " + (session.user.email || "已登录");
      synced = true;
    } catch {
      $("cloud-state").textContent = "已登录 · 云同步失败";
    }
  }
  render();
  return synced;
}

async function refreshCloudRecords() {
  if (!repository.isCloudUser()) return;
  try {
    await repository.syncCloud();
    state.records = repository.list();
    $("cloud-state").textContent = "已同步";
    render();
  } catch {
    $("cloud-state").textContent = "云同步暂不可用";
  }
}

if (cloud.isConfigured()) {
  $("cloud-panel").hidden = false;
  $("cloud-auth-form").onsubmit = async event => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      const session = await cloud.signIn(String(formData.get("email")).trim(), String(formData.get("password")));
      const synced = await applyCloudSession(session);
      notify(synced ? "云端登录成功，客户记录已同步。" : "已登录，但云端同步未完成，请检查数据库配置。");
    } catch (error) { notify("登录失败：" + error.message); }
  };
  $("cloud-signup").onclick = async () => {
    const formData = new FormData($("cloud-auth-form"));
    const email = String(formData.get("email") || "").trim();
    const password = String(formData.get("password") || "");
    if (!email || password.length < 8) { notify("请填写邮箱和至少 8 位密码。"); return; }
    try {
      const session = await cloud.signUp(email, password);
      if (session) {
        const synced = await applyCloudSession(session);
        notify(synced ? "云端账号已创建并登录。" : "账号已创建，但云端同步未完成，请检查数据库配置。");
      } else notify("账号申请已提交，请按邮件提示完成验证后登录。");
    } catch (error) { notify("创建账号失败：" + error.message); }
  };
  $("cloud-signout").onclick = async () => {
    try { await cloud.signOut(); } finally { await applyCloudSession(null); }
  };
  $("guest-import").onclick = async () => {
    try {
      const count = await repository.importGuestRecords();
      state.records = repository.list(); render();
      notify(`已将 ${count} 条本机记录合并到当前账号。`);
      $("guest-import-note").hidden = $("guest-import").hidden = true;
    } catch { notify("导入失败，请检查账号登录和云端连接后重试。"); }
  };
  cloud.restoreSession().then(applyCloudSession).catch(() => applyCloudSession(null));
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
  $("rows").innerHTML = leads.map((lead, index) => {
    const record = recordFor(lead);
    return '<tr><td><strong>' + esc(lead.name) + '</strong><small>' + link(lead.website, lead) + '</small><small>' + badge(lead) +
      '</small></td><td>' + esc(lead.market || "未获取") + '</td><td>' + esc(lead.type || "待核实") + '<small>' + esc(lead.business || "未获取") +
      '</small></td><td><span class="badge">' + esc(record.status) + '</span></td><td class="row-actions">' +
      '<button data-detail="' + index + '">详情</button><button data-save="' + index + '" aria-pressed="' + record.saved + '">' +
      (record.saved ? "已收藏" : "收藏") + '</button></td></tr>';
  }).join("") || '<tr><td colspan="5" class="empty">暂无符合条件的线索。</td></tr>';
  $("rows").onclick = event => {
    const button = event.target.closest("button");
    if (!button) return;
    const lead = leads[Number(button.dataset.detail ?? button.dataset.save)];
    if (button.dataset.detail !== undefined) showDetail(lead);
    else if (updateRecord(lead, {saved:!recordFor(lead).saved})) notify(recordFor(lead).saved ? "已收藏" : "已取消收藏");
  };
}
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
  $("detail-body").innerHTML = '<div class="detail-grid">' + fields.map(([key,value]) => '<div><b>' + key + '</b>' + value + '</div>').join("") +
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
form.elements.namedItem("mode").onchange = () => {
  activeSearch?.abort();
  state.results = [];
  state.mode = form.elements.namedItem("mode").value;
  render();
};
form.onreset = () => {
  activeSearch?.abort();
  state.results = [];
  state.mode = "demo";
  state.product = "";
  $("filter").value = $("status-filter").value = "";
  render();
};
form.onsubmit = async event => {
  event.preventDefault();
  const query = Object.fromEntries([...new FormData(form)].map(([key,value]) => [key, value.trim()]));
  if (!query.product) { notify("请输入产品名称。"); form.elements.namedItem("product").focus(); return; }
  activeSearch?.abort();
  const request = activeSearch = new AbortController();
  state.mode = query.mode;
  state.product = query.product;
  state.results = [];
  $("filter").value = $("status-filter").value = "";
  render();
  $("count").textContent = "正在搜索…";
  try {
    const leads = await searchLeads(query, request.signal);
    if (request.signal.aborted) return;
    state.results = leads;
    render();
    if (state.page === "search" && event.submitter) notify("搜索完成，找到 " + visibleLeads().length + " 条线索");
  } catch (error) {
    if (request.signal.aborted) return;
    render();
    if (state.page === "search") $("count").textContent = error.message;
  }
};
$("export").onclick = () => {
  const headers = ["数据类型","公司名称","官网","国家/地区","客户类型","主营业务","联系方式","匹配理由","来源链接","来源日期","收藏","跟进状态","跟进备注"];
  const leads = visibleLeads();
  const rows = leads.map(lead => {
    const record = recordFor(lead);
    return [sourceName(lead),lead.name,lead.website,lead.market,lead.type,lead.business,lead.contact,lead.reason,lead.source,lead.date,record.saved ? "是" : "否",record.status,record.note];
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
