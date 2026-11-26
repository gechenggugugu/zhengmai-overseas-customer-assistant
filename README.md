# 正麦海外客户开发助手

零依赖中文静态网站，支持 Windows 11 免安装运行和 GitHub Pages 发布。网站与本地版共用同一套页面和业务模块。

国家/地区使用 `backend/supabase/functions/_shared/markets.json` 中的统一列表（ISO 3166-1 两位代码及中英文名称）。页面支持按名称搜索、单选、全部市场全球搜索和马来西亚、阿联酋、澳大利亚、越南、沙特阿拉伯快捷选择。

## 本机使用

解压后双击 `start-windows.bat`。浏览器打开 `http://127.0.0.1:4173/`，关闭启动窗口即可停止。演示模式无需联网；客户记录默认仅保存在当前浏览器。

## 在线发布

正式网址：[https://gechenggugugu.github.io/zhengmai-overseas-customer-assistant/](https://gechenggugugu.github.io/zhengmai-overseas-customer-assistant/)。源码仓库：[gechenggugugu/zhengmai-overseas-customer-assistant](https://github.com/gechenggugugu/zhengmai-overseas-customer-assistant)。当前由 `main` 分支根目录发布。重新发布时，将项目根目录内容（包括 `backend/supabase/functions/_shared/markets.json`）上传到仓库并在 Settings → Pages 检查发布来源。静态演示不需要环境变量；部署说明见 [implementation.html](./implementation.html)。

## 云端登录与跨设备同步

前端已包含邮箱认证和云同步接口。要启用需由项目所有者创建 Supabase 项目、执行 `backend/supabase/migrations/` 下的迁移、部署 Edge Function，并在 `public-config.js` 填项目 URL 与 publishable/anon key。令牌采用 PKCE + 标签页会话存储。搜索 API 密钥只存 Supabase Edge Function Secrets。访客数据须登录后主动点“导入本机记录”。详细步骤见 [backend/README.md](./backend/README.md)。

当前未在公开配置中填写 Supabase 公钥或搜索供应商密钥；真实搜索不会回退到演示数据。联系人挖掘仅对真实企业按需开放，并复用同一登录保护接口及搜索额度。演示公司的名称、联系方式和 `.example` 链接都是虚构样本。

## 验证

安装 Node.js 后运行 `node --test tests/*.test.mjs`。应用与 Windows 启动不依赖 Node.js；Node 仅运行开发测试。

