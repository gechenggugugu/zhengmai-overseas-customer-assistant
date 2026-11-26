# 正麦海外客户开发助手

零依赖中文静态网站，支持 Windows 11 免安装运行和 GitHub Pages 发布。网站与本地版共用同一套页面和业务模块。

## 本机使用

解压后双击 `start-windows.bat`。浏览器打开 `http://127.0.0.1:4173/`，关闭启动窗口即可停止。演示模式无需联网；客户记录默认仅保存在当前浏览器。

## 在线发布

将项目根目录内容上传到 GitHub 仓库。GitHub Free 使用 Pages 需公开仓库，在 Settings → Pages 选择从 `main` 分支的 `/(root)` 发布。需要 GitHub 账号与仓库管理权限。静态演示不需要环境变量；部署说明见 [implementation.html](./implementation.html)。

## 云端登录与跨设备同步

前端已包含邮箱认证和云同步接口。要启用需由项目所有者创建 Supabase 项目、执行 `backend/supabase/migrations/` 下的迁移、部署 Edge Function，并在 `public-config.js` 填项目 URL 与 publishable/anon key。该公钥只在启用 RLS 后放入浏览器。搜索 API 密钥只存 Supabase Edge Function Secrets。详细步骤见 [backend/README.md](./backend/README.md)。

当前没有配置真实搜索供应商或 Supabase 项目；真实搜索不会回退到演示数据。演示公司的名称、联系方式和 `.example` 链接都是虚构样本。

## 验证

安装 Node.js 后运行 `node --test tests/*.test.mjs`。应用与 Windows 启动不依赖 Node.js；Node 仅运行开发测试。

