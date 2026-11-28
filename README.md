# 正麦海外客户开发助手

零依赖中文静态网站，支持 Windows 11 免安装运行和 GitHub Pages 发布。网站与本地版共用同一套页面和业务模块。

国家/地区使用 `backend/supabase/functions/_shared/markets.json` 中的统一列表（ISO 3166-1 两位代码及中英文名称）。页面支持按名称搜索、单选、全部市场全球搜索和马来西亚、阿联酋、澳大利亚、越南、沙特阿拉伯快捷选择。

## 本机使用

解压后双击 `start-windows.bat`。浏览器打开 `http://127.0.0.1:4173/`，关闭启动窗口即可停止。根目录版本会加载当前 `public-config.js`：目前它指向 Staging 并启用云登录入口；搜索默认仍是演示样本，只有选择“真实搜索”并完成 Staging 后端验收后才会调用真实搜索。未登录时收藏和跟进保存在当前浏览器，登录后修改会同步到 Staging。若使用 `deliverables` 下生成的空 key 预览包，则云端登录/同步不可用，只能使用演示搜索和本机记录。

## 在线发布

Staging 发布使用单独生成的目录，公开文件由 `site-files.json` 列出。预览目录的 Staging 公开 key 留空。获批后为目标站点配置 Staging 公开 key，并将站点来源加入 Auth 回跳和函数允许列表。打包方式见 [Staging 发布准备](./backend/deployment/staging-site/README.md)，日常操作见 [使用说明](./implementation.html)。

**当前公开站点状态（2026-11-28 核查）：** `https://gechenggugugu.github.io/zhengmai-overseas-customer-assistant/` 返回 HTTP 200，但部署文件与当前源码不一致；其静态公开配置指向非 Staging 项目。不要用该地址进行 Staging 登录、搜索或其他验收。核查只读取了 GitHub 静态文件，没有请求 Supabase API。GitHub 仓库默认分支是 `main`，仓库 README 声称 Pages 从 `main` 根目录发布；只读比对发现 `main` 上的页面、应用、同步、样式、使用说明与市场数据文件都与当前本地源码不同。直接修改该公开分支可能触发线上发布。更换线上配置或发布更新属于正式网站发布，须先完成后端验收、核对 Pages 来源并取得明确批准。

## 云端登录与跨设备同步

前端已包含邮箱认证和云同步接口。`public-config.js` 当前已配置 Staging URL 和 `supabasePublishableKey`。正式启用还需核实并按审批流程应用迁移、部署 Edge Functions。令牌采用 PKCE + 标签页会话存储。搜索 API 密钥只存 Supabase Edge Function Secrets。访客数据须登录后主动点“导入本机记录”。详细步骤见 [backend/README.md](./backend/README.md)。

`public-config.js` 中已配置 Staging 项目 URL 和 Supabase publishable key。公开配置仍需配合数据库 RLS 使用。文件中没有搜索供应商密钥或 service-role key。线上 Edge Function Secrets 是否齐备、真实搜索是否可用，尚未由本地配置验证。真实搜索不会回退到演示数据。联系人挖掘仅对真实企业按需开放，并复用同一登录保护接口及搜索额度。演示公司的名称、联系方式和 `.example` 链接都是虚构样本。

## 验证

安装 Node.js 后运行 `node --test tests/*.test.mjs`。应用与 Windows 启动不依赖 Node.js；Node 仅运行开发测试。

