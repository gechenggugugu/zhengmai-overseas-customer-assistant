# 云端搜索与客户同步后端

前端仍由同一套 `index.html`、`app.mjs` 和 `services.mjs` 驱动。Windows 启动器与静态网站均加载这些文件；只有填写 Supabase 项目配置后，登录、跨设备同步和真实搜索接口才会启用。

## 组件

- Supabase Auth：邮箱与密码登录；用户记录按 Auth 用户 ID 隔离。
- Supabase Postgres：`lead_records` 存储收藏、跟进状态、备注、历史和线索内容；SQL 启用 RLS，只允许用户访问自己的行。
- Supabase Postgres：`consume_search_daily_limit()` 以数据库原子更新限制每用户每日 5 次、项目全体每月 150 次。每次请求执行 1 次 Tavily basic query（通常 1 credit），所以数据库月上限对应最多 150 次 Tavily 搜索；配额写死于数据库且不接受客户端覆盖。
- Supabase Edge Function：`leads-search` 验证登录用户并检查每日限额后请求搜索 API 适配器。密钥以函数环境变量保存。
- 搜索供应商适配器：需选择并获准使用的搜索 API，提供兼容的 POST 接口，接收前端查询并返回 `{ "leads": [...] }`。若供应商响应格式不同，在函数中实现对应适配。结果必须保留可核验来源 URL；缺少来源的记录会被丢弃。
- 国家/地区在 `supabase/functions/_shared/markets.json` 统一配置，包含 249 个 ISO 3166-1 两位代码及中英文名称。前端传代码，函数可兼容旧的中文或英文名称输入。Tavily 收到其支持地区的英文国家名；其他地区仍通过关键词搜索，未选市场则不指定国家。Brave 只对已确认支持的既有 11 个市场发送 ISO 代码，其余只用关键词定位，避免提交不支持的地区码。
- 每次用户搜索保持一个 Tavily basic 请求（通常 1 credit）；产品、客户类型、国家及经销/进口/批发同义词在同一查询中扩展。结果按规范化主机名去重，www 与非 www 的重复站点合并。

`leads-search` 也支持 `{ "action":"contacts", "company":{"name":"...","website":"...","market":"MY"} }` 联系人搜索请求。它先走相同的 Supabase Auth 校验和 `consume_search_daily_limit()`，然后只发一条 Tavily basic / Brave 查询。采购职位优先，同时覆盖 Owner、Founder、Managing Director、CEO。仅当公开搜索结果文本同时包含目标公司、支持职位和可识别姓名时返回候选；社交链接必须来自 LinkedIn/Facebook 结果页，邮箱必须出现在结果摘要中，电话仅从带 phone/tel/call 标签的摘要提取。结果均为待核实候选，需人工打开证据来源确认。

真实搜索目前不会使用示例客户。未配置后端、未登录或未配置搜索供应商时，真实搜索明确失败；演示样本继续标为模拟数据。

## 数据隔离和同步

迁移文件 `supabase/migrations/20261126000100_lead_records.sql` 创建逐用户表和四项 RLS 策略。前端只保存 Supabase **publishable/anon** key；此公钥不具备绕过 RLS 的权限。服务端密钥（例如 `SEARCH_API_KEY`、Supabase secret/service-role key）不得加入 `public-config.js`。该 Edge Function 只用 Supabase Auth 验证用户，不需要 service-role key。

登录设备在本机保存自己的会话与缓存，登录时拉取云端记录并按数据库时间合并，修改后立即上传；页面保持打开时每 60 秒和窗口重新变为活动状态时检查一次云端变化。退出登录不删除云端记录。本机访客数据留在访客存储区，不自动上传给某个账户。

## 部署顺序

1. 由项目所有者登录 Supabase 并创建项目。当前 Supabase 定价页列有 $0 Free 层，但免费项目会在连续一周不活跃后暂停；本 MVP 不要求付费升级。
2. 在 Supabase Auth 设置邮箱登录，并在公开使用前启用邮箱验证；部署时须配置可工作的验证邮件发送方式。
3. 安装 Supabase CLI，在 `backend` 文件夹运行 `supabase login` 和 `supabase link --project-ref <项目引用>`。先用 `supabase db push --dry-run` 预览迁移，再运行 `supabase db push`；按 CLI 提示确认后会创建用户数据表与搜索额度函数。官方说明见 [数据库迁移部署](https://supabase.com/docs/guides/deployment/database-migrations)。
4. 运行 `supabase functions deploy leads-search --use-api` 部署 Edge Function（API 部署不需要本机 Docker）。
5. 在 Supabase Dashboard 的 Edge Function Secrets 设置 `APP_ORIGINS=https://gechenggugugu.github.io,http://127.0.0.1:4173`。部署后若要启用真实搜索，再配置 `SEARCH_PROVIDER=tavily`、`SEARCH_API_KEY`；Tavily URL 默认官方 endpoint。Brave 可设置 `SEARCH_PROVIDER=brave`，但当前结果保存/AI流程需先确认其条款适用。可选 `AI_API_URL`、`AI_API_KEY`、`AI_MODEL` 启用 OpenAI-compatible 评分和草稿生成；全部未设置时不调用模型，使用规则初筛和模板草稿。AI API 可能收费，保持空值即不会触发。不要设置自动充值，不要把密钥写入源码。官方密钥说明见 [Edge Function Secrets](https://supabase.com/docs/guides/functions/secrets)。
6. 在 `public-config.js` 填 `supabaseUrl` 和 `supabasePublishableKey`（也兼容 `supabaseAnonKey`）。可以把此公开配置提交到 GitHub，因为它不是秘密且数据库有 RLS；不要放 secret key、service-role key、搜索 API key 或数据库密码。

浏览器会通过 Supabase JS SDK 使用 PKCE，令牌只存于 `sessionStorage`，关闭标签页后需要重新登录。此设置缩短会话持久性，但前端令牌仍可能被同源 XSS 读取；请继续保持依赖最少、对所有动态文本做转义，并配置严格 CSP。访客本地记录在用户登录后会显示显式导入按钮，只有点击后才合并到该账号。
7. 部署静态网站后，用邮箱创建账号，在本机和另一台设备登录并验证收藏/跟进同步。

这些云服务设置需要所有者登录并操作。本次未创建 Supabase 项目、执行线上迁移、部署函数、启用收费功能或填入任何密钥。

更多安全背景：[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[API keys](https://supabase.com/docs/guides/getting-started/api-keys)、[Edge Function 部署](https://supabase.com/docs/guides/functions/deploy)。

