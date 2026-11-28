# 身份无关后端源码同步候选

状态：仅本地审查清单，未上传、未合并、未部署。

该 allowlist 包含当前登录、真实搜索、联系人搜索、配额预扣/确认/退款、管理员配额操作及身份无关额度迁移所需源码。候选迁移在公开副本中应安装为 00200 之后的后续 migration；它可从干净的本地 002 基线启动，也可替换已存在的旧管理员 setter。不能把本清单当作当前 Staging 数据库执行顺序：先对账迁移账本并取得经过恢复验证的备份。

明确排除的两份原始迁移含专属账号身份绑定信息；candidate migration 以 owner-only 授权注册表替代硬编码。旧私有部署包、任何环境文件和凭据也不得纳入公开副本。

运行 `node --test tests/public-backend-source-safety.test.mjs` 会核对清单文件存在，并扫描其中 UUID、邮箱、常见 token/secret 形态和排除路径。该扫描不保证审查整个 Git 历史，也不能替代人工逐文件 review。

公开源码同步与 Staging 部署是分开的：同步仅用于 review，不执行 SQL、不配置 Secrets、不部署函数、不发布网站。当前 Staging 备份与独立恢复尚未通过。
