# 云端搜索与客户同步后端

前端仍由同一套 `index.html`、`app.mjs` 和 `services.mjs` 驱动。Windows 启动器与静态网站均加载这些文件；只有填写 Supabase 项目配置后，登录、跨设备同步和真实搜索接口才会启用。

## 组件

- Supabase Auth：邮箱与密码登录；用户记录按 Auth 用户 ID 隔离。
- Supabase Postgres：`lead_records` 存储收藏、跟进状态、备注、历史和线索内容；SQL 启用 RLS，只允许用户访问自己的行。
- Supabase Postgres：本地配额策略为普通账号每日 5 次、管理员每日 60 次、经独立授权的专属账号每日不限，全项目月度共享上限 1000 次。迁移 00250 先移除 `lead_records` 的危险表级权限和旧额度 RPC 客户端执行权；数据库历史以 Staging 实际核验为准。所有变更均须保留客户资料、收藏、跟进和额度历史。
- 额度按 UTC 统计，按“预扣、成功确认、失败退款”三阶段处理；请求 UUID 在数据库流水中唯一，同一预留不能重复扣款或退款。月度项目计数行加锁后才预扣，防止并发超过上限。搜索失败、超时、供应商 HTTP 错误、JSON/结果无效和用户取消会退款；进程中断时预留 5 分钟后释放。取消发生在供应商已收到请求之后，应用额度会退回，但供应商是否计费由其规则决定。
- 配额界面显示今日已用/剩余、本月全项目已用/剩余、UTC 重置时间、专属账号授权状态及供应商返回的 API Credits。管理入口只有可信管理员身份才显示；数据库写 RPC 从 Auth 的 `raw_app_meta_data.role` 再校验管理员，浏览器不能直接调用管理写 RPC。管理员每日固定 60 次；可将月度上限设为 1–1000 次。
- 搜索结果缓存 6 小时，按规范化查询和供应商的 SHA-256 键复用；缓存仅对 Edge Function 的服务端角色开放，不缓存联系人挖掘结果。缓存命中仍消耗应用搜索额度，但不会新发起供应商搜索。供应商结果另按公司标题及网站主机名去重。缓存不可用时退回正常搜索，不影响结果。
- Supabase Edge Function：`leads-search` 验证登录用户，生成/校验每次搜索的 UUID 请求编号，使用同一编号调用预留、确认、退款 RPC，再请求搜索 API 适配器。重复提交相同编号不会再次调用供应商；页面每次新的搜索动作生成新编号。密钥以函数环境变量保存。
- 搜索失败时返回稳定诊断码与不含内部细节的提示；函数日志按请求 ID 记录认证、额度、provider 阶段及错误分类，不记录令牌、密钥、请求内容、用户 ID、供应商 URL 或异常文本。provider 错误码包括 `search_provider_timeout`、`search_provider_http_error`、`search_provider_invalid_json`、`search_provider_not_configured` 和 `search_internal_error`。
- 搜索供应商适配器：需选择并获准使用的搜索 API，提供兼容的 POST 接口，接收前端查询并返回 `{ "leads": [...] }`。若供应商响应格式不同，在函数中实现对应适配。结果必须保留可核验来源 URL；缺少来源的记录会被丢弃。
- 国家/地区在 `supabase/functions/_shared/markets.json` 统一配置，包含 249 个 ISO 3166-1 两位代码及中英文名称。前端传代码，函数可兼容旧的中文或英文名称输入。Tavily 收到其支持地区的英文国家名；其他地区仍通过关键词搜索，未选市场则不指定国家。Brave 只对已确认支持的既有 11 个市场发送 ISO 代码，其余只用关键词定位，避免提交不支持的地区码。
- Tavily 请求使用 `search_depth:"basic"` 和 `include_usage:true`。界面只显示供应商响应中可验证的 `usage.credits`；供应商未返回时显示“未提供”，不推算。Basic 与 Advanced 的 Credits 规则及账户当前套餐应以 Tavily 官方控制台为准。应用的 1000 次月额度不代表 1000 Credits，也不能保证 API 账单不超过 8 美元。

`leads-search` 也支持 `{ "action":"contacts", "company":{"name":"...","website":"...","market":"MY"} }` 联系人搜索请求。它使用相同的预留、成功确认、失败退款流程，然后只发一条 Tavily basic / Brave 查询。相同请求编号重复提交会返回冲突，不会再次请求供应商。采购职位优先，同时覆盖 Owner、Founder、Managing Director、CEO。仅当公开搜索结果文本同时包含目标公司、支持职位和可识别姓名时返回候选；社交链接必须来自 LinkedIn/Facebook 结果页，邮箱必须出现在结果摘要中，电话仅从带 phone/tel/call 标签的摘要提取。结果均为待核实候选，需人工打开证据来源确认。

真实搜索目前不会使用示例客户。未配置后端、未登录或未配置搜索供应商时，真实搜索明确失败；演示样本继续标为模拟数据。供应商已接收请求但响应超时的情况下，应用额度仍会退回；供应商自身是否已计费由供应商规则决定。

## 数据隔离和同步

迁移文件 `supabase/migrations/20261126000100_lead_records.sql` 创建逐用户表和四项 RLS 策略。目标部署后，浏览器用用户 JWT 读取自己的额度状态和客户记录；`leads-search` 与 `quota-admin` Edge Function 验证用户 JWT 后，由服务端密钥调用预扣/确认/退款和管理员写 RPC。数据库从 Auth 的可信 `raw_app_meta_data.role` 再核验管理员。service-role 密钥不得加入 `public-config.js`。

登录设备在本机保存自己的会话与缓存，登录时拉取云端记录并按数据库时间合并，修改后立即上传；页面保持打开时每 60 秒和窗口重新变为活动状态时检查一次云端变化。退出登录不删除云端记录。本机访客数据留在访客存储区，不自动上传给某个账户。

同步请求绑定发起时的账号。同一条记录连续编辑时按顺序提交，迟到的响应不会覆盖本机较新的编辑。切换账号后，旧账号的同步和额度响应会被丢弃。本地回归覆盖延迟响应与账号切换，跨电脑同步仍需在 Staging 发布后实测。

云端读取按账号内的记录键分批取回。达到 API 单次返回上限时会继续读取剩余记录。若后续批次失败，同步会显示错误，不会把读取到的部分数据当成一次完整同步。

已同步过的线索按数据库的原始更新时间戳做条件保存。另一台电脑已写入新版本时，详情显示云端现有内容，并在本机保留被拦截的跟进修改供核对。这个行为使用现有表和 RLS，无需添加迁移。

## Staging 部署准备（当前未执行）

唯一允许的远端目标是 Supabase Staging `tcpwezjcuzuawvijqukl`。本地报告记录的旧只读结果不是当前状态证明；真实数据库目录、额度历史、迁移账本、函数版本及 Secrets 状态都必须在后续获批核查中重新确认。当前 PostgreSQL Session Pooler TLS/备份问题未解决，真实备份与独立恢复验证未完成，因此数据库升级门关闭。身份无关授权注册表迁移仅为本地候选，尚未部署。

**不要使用**历史目录 [`backend/deployment/quota-rollout/README.md`](deployment/quota-rollout/README.md)：其中保留了历史远端操作命令及私有身份配置材料，是封存的历史材料，不是 Staging 执行指南。当前可审阅的 Staging 配额准备资料位于 [`backend/deployment/staging-quota/README.md`](deployment/staging-quota/README.md)。它只生成本地 SQL 预览、最小备份草案和隔离恢复验证；本地草案不会授权或自动执行远端操作。

后续顺序：先解决 Staging 数据库安全连接；按审批进行只读 catalog/额度核验；创建最小快照并通过独立 PostgreSQL 恢复验证；再根据已核实迁移账本选择经审查的升级方案（旧 004–006 或身份无关候选，不得混用或重放）。迁移获批并验证后，才准备两个 Edge Functions 的 Staging 部署、所需 Secrets 名称核对及 Staging 网站来源/CORS 方案；每种远端变更仍分别审批。不得运行 `supabase db push`，不得把私有部署包、数据库密码、Secret 或 service-role key 放入公开网站文件。

Staging 部署前只核对所需 Secrets 名称/存在状态，不读取或记录值；函数源码来自 `backend/supabase/functions/`。此前的 OPTIONS/HTTP 状态不能证明部署源码、身份验证、Secrets 或真实搜索正常。

确认 `public-config.js` 的 `supabaseUrl` 和 publishable key 指向目标项目。公开配置可提交，但不能放 secret key、service-role key、搜索 API key 或数据库密码。管理员身份仅用 Auth `app_metadata.role=admin`，数据库从 `raw_app_meta_data.role` 再核验。

浏览器会通过 Supabase JS SDK 使用 PKCE，令牌只存于 `sessionStorage`，关闭标签页后需要重新登录。此设置缩短会话持久性，但前端令牌仍可能被同源 XSS 读取；请继续保持依赖最少、对所有动态文本做转义，并配置严格 CSP。访客本地记录在用户登录后会显示显式导入按钮，只有点击后才合并到该账号。

只有在 Staging 函数和数据库均经批准部署后，才验证管理员配置与跨设备同步。管理员经 `quota-admin` Edge Function 操作，数据库再验证 `auth.users.raw_app_meta_data.role`；浏览器只能读取当前用户额度，不能直接预扣、确认、退款或调用管理员写 RPC。最终验收须用测试账号在两台设备登录，验证收藏和跟进同步。

## 最终部署核对清单

### 部署前

- [ ] 核对 Staging 项目 ID 与 `public-config.js` 一致，并确认当前迁移历史；不假设迁移账本或任何迁移已执行。
- [ ] 只读检查额度表 RLS、`consume_search_daily_limit()` 是否仍存在、004–006 函数签名与 `authenticated` / `service_role` EXECUTE 权限；预览将执行的 SQL。
- [ ] 若单独批准专属额度授权，使用独立 owner 控制的授权注册表；账号身份值不得进入报告、公开仓库或网站文件。
- [ ] 确认管理员来自 Auth `app_metadata.role=admin` / 数据库 `raw_app_meta_data.role=admin`。普通账号不得有预扣、确认、退款或管理员写 RPC 权限。
- [ ] 确认 Staging 迁移基线，不重放已有迁移；客户资料、收藏、跟进及额度历史不得被删除或重置；先完成经验证备份和恢复。私有部署文件须从公开网站上传集和公开仓库排除。
- [ ] 先通过 Staging 备份与恢复门；再分别取得 Staging 数据库迁移、Edge Function 部署、Secrets 修改、网站发布和专属额度授权的明确批准。

### 发布后验证

- [ ] 普通账号每日上限为 5，管理员为 60，已获 owner 授权的专属账号为每日不限；三者均受共享月度 1000 次上限约束。
- [ ] 两个 Edge Function 可验证用户会话；前端不能直接执行预扣、确认、退款或管理员写 RPC，浏览器配置和响应中不含 service-role 密钥。
- [ ] 在低风险测试窗口验证并发不会突破月上限；成功确认只记一次，失败/超时/取消退款仅一次，重复 `request_id` 不重复搜索或重复退款。
- [ ] 检查原客户资料、收藏、跟进记录仍可读取，RLS 仍将每个账号限制为自己的记录。
- [ ] 如 Shelly 核验或迁移失败，停止发布，不改 Auth 邮箱、密码或角色来绕过核验；先核对 Auth 记录和数据库迁移状态。

## 回滚预案

- 006 只撤销旧浏览器管理员 RPC 并新增 service-role-only 写入口；原 007 文件用于一次性账号绑定，仍属私有身份配置。身份无关候选则使用单独的授权注册表。若 Edge Function 或页面发布失败，先回退静态前端/函数版本，保持数据库中旧管理 RPC 仍被撤销；此时管理员界面可能暂不可用，搜索额度流程不应退回旧 `consume_search_daily_limit()`。
- 若 006 因依赖、权限或 schema 状态不符而失败，PostgreSQL 事务会阻止该迁移落地。不要用 `CASCADE` 或手工删除对象；先核对依赖，再准备新的向前修复迁移。
- 迁移成功后不要重放 001–003，也不要把月度限制重置到旧的 150。不要删除/重建业务表作为回滚方式。任何线上 SQL、迁移应用或函数部署都须另行明确确认。
- 若专属账号授权需要撤销，应通过 owner-only 授权撤销流程；不要手改 Auth 用户或删除额度历史。此授权撤销属于远端数据库操作，须单独批准。

## 本地验证

从项目根目录用 Node.js 24 运行 `node --test tests/*.test.mjs`。若要运行实际 SQL 测试，将 `QUOTA_TEST_PGLITE_PATH` 指向本机 PGlite 0.3.14 的 `dist/index.js`，然后运行同一命令。测试使用内存数据库和模拟的 Auth、搜索供应商，不连接 Supabase。

发布前也应使用 Deno 检查两个函数的类型并运行本机 HTTP 测试：

```powershell
deno check --no-config backend/supabase/functions/leads-search/index.ts backend/supabase/functions/quota-admin/index.ts
deno test --no-config --allow-net=127.0.0.1 tests/edge-deno-smoke.mjs
```

HTTP 测试使用本机 Deno 服务器及模拟上游，检查会话、来源链接、成功确认、错误退款和管理员权限。选择时间范围时，Tavily 按发布时间窗口过滤，Brave 使用对应日期范围。真实上线仍需 Staging 端到端验收。[Tavily 时间参数](https://docs.tavily.com/documentation/api-reference/endpoint/search) · [Brave Web Search 文档](https://api-dashboard.search.brave.com/app/documentation/web-search)

可选 AI 仅补充评分、匹配理由和英文草稿。返回项必须对应实际发给模型的来源。AI 请求不另传联系字段，搜索摘要仍作为输入证据。模型不可用时保留搜索供应商结果和规则初筛，不修改原始来源或联系方式。

真实搜索和联系人挖掘失败时会在页面显示请求编号，便于管理员关联函数诊断日志。只有后端确认退款时才显示额度已退回。结算不明或网络断开时，可先刷新额度再决定是否重试。

## Tavily 费用监控

Edge Function 当前请求 Tavily Basic Search。官方说明显示 Basic 和 Advanced 的 Credits 消耗不同；应以每次 API 响应 `usage.credits` 及当前套餐账单为准，不把一次应用搜索等同一个 Credit。Tavily 当前定价页面列出按量价约 `$0.008/Credit`，但账户是否有免费额度、套餐和汇率/税费以控制台为准，因此 `$8` 只是预算目标，不是此应用能强制保证的上限。详见 [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[Credits 说明](https://help.tavily.com/articles/8298987937-billing-credits-usage-limits) 和 [定价](https://www.tavily.com/pricing)。

人工设置费用监控：登录 Tavily 控制台，在 **Usage** 查看调用和 Credits；在 **Billing / Plan** 为 Pay-as-you-go 设置每月消费上限（若当前账户和计划提供该选项），同时检查免费额度、付款方式和告警。不要启用自动充值，不要购买套餐。API Key 页面可能提供每 Key 月度使用限制，可作为额外限制；不能替代账户账单监控。官方指引：[Usage Dashboard](https://help.tavily.com/articles/7015474742-tavily-usage-dashboard)、[按量月度上限](https://help.tavily.com/articles/8280756099-how-to-set-a-limit-for-pay-as-you-go-option)、[API Key 管理](https://help.tavily.com/articles/9170796666-how-can-i-create-an-api-key)。

这些云服务设置需要所有者登录并操作。本次未创建 Supabase 项目、执行线上迁移、部署函数、启用收费功能或填入任何密钥。

更多安全背景：[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[API keys](https://supabase.com/docs/guides/getting-started/api-keys)、[Edge Function 部署](https://supabase.com/docs/guides/functions/deploy)。

