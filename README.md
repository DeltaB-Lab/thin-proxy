# thin-proxy

项目仓库：[DeltaB-Lab/thin-proxy](https://github.com/DeltaB-Lab/thin-proxy)，SSH 地址：`git@github.com:DeltaB-Lab/thin-proxy.git`。

单用户 Cloudflare Worker 反向代理。客户端固定地址与转发 Key，网页切换上游 URL 和上游 Key。TypeScript + D1 + 默认 30 秒实例内存缓存。

管理界面采用黑白灰侧栏布局，首页、上游与 API Keys 分区；登录页只需输入密钥。功能说明保留在本文档和折叠的“接入方式”中。

## 做什么

- Secret 中的管理密钥登录网页；创建独立的、仅用于调用的转发 Key。
- 保存多个上游，所有转发 Key 共用一个当前上游。
- HTTP / SSE / WebSocket 转发，原请求体与响应体直接作为流传递。
- 不解析业务 JSON、表单、SSE 事件或 WebSocket 消息，不改层级、套壳或重序列化。
- 只调整目标 URL、鉴权字段，以及代理协议所需的头。不自动重试、故障切换或跟随重定向。
- 单行 D1 配置；无用户表、会话表、请求日志、对话存储或用量统计。

## 本地运行

需要 Node.js 22.12+ 或受 Wrangler 支持的更新版本。

```sh
npm ci
npm run init:local
npm run db:local
npm run dev
```

打开 `http://localhost:8787/_relay/`，使用 `.dev.vars` 中的 ADMIN_KEY 登录。脚本只创建本地随机密钥，不输出密钥、不覆盖已有文件；不要提交 `.dev.vars`。浏览器需支持 localhost 上的 Secure Cookie；若当前浏览器限制它，可使用 `npm run dev -- --local-protocol https` 或直接运行 `npx wrangler dev --local-protocol https`（先构建页面）。不要通过关闭 Secure 属性解决生产登录问题。

开发流程：添加上游 → 设为当前 → 创建转发 Key → 配置客户端。上游必须是公开 HTTPS 地址，不能指向 Worker 自身。第一版拒绝 IPv6 字面量和本机、明显私网地址，域名解析不做完整 DNS 防护；由唯一管理者配置受信任目的地址。

## 部署到 Cloudflare

当前生产环境已部署，管理页面为 `https://llm-api.drt3b.com/_relay/`，代理地址为 `https://llm-api.drt3b.com`。仅 main 分支自动部署；workers.dev、版本预览 URL 和预览分支构建均关闭。部署设置见 [自动部署文档](docs/04-自动部署.md)。

本机生产管理密钥保存在 Git 忽略的 `.env` 中（ADMIN_KEY），只供读取并登录生产网页；本地开发仍使用 `.dev.vars`。不要上传这些文件。自定义域名是代理入口，不能把 `llm-api.drt3b.com` 配为上游。

在其他 Cloudflare 账户新建环境时，按顺序操作：

1. `npx wrangler login`。
2. `npx wrangler d1 create thin-proxy`。
3. 将自己的账号 ID、数据库 ID 和自定义域名填进 `wrangler.jsonc`。仓库中的值属于当前生产环境，不能直接用于其他账户。
4. 设置 `SELF_HOSTS` 为全部代理域名（逗号分隔，包括 workers.dev 和自定义域名），避免别名回源循环。当前请求域名也会自动拒绝为上游。
5. 用密码管理器或本地安全随机数生成器准备两个独立密钥：ADMIN_KEY 至少 32 个随机字符；UPSTREAM_KEY_ENCRYPTION_KEY 为恰好 32 随机字节的 Base64 编码。
6. 使用下面的交互式命令写入 Secret，不把真实密钥写进命令行或普通 vars：

```sh
npx wrangler secret put ADMIN_KEY
npx wrangler secret put UPSTREAM_KEY_ENCRYPTION_KEY
npm run db:remote
npm run deploy
```

打开 `https://你的域名/_relay/` 登录。两个 Secret 可以先通过 Cloudflare 控制台配置；部署流程依赖有效的账户权限。D1 刷新和管理读写明确使用 `first-primary` 会话，不依赖副本陈旧读取。

`compatibility_date` 固定为本地已验证运行时支持的 `2026-08-06`，而非自动追随当前日期；升级兼容日期后重新验证 WebSocket 等行为。

## 客户端配置

```text
Base URL: https://你的域名
API Key: 网页创建的 relay_... 转发 Key
```

客户端需要 /v1 时可以填 `https://你的域名/v1`。支持 `Authorization: Bearer <转发Key>` 或 `x-api-key: <转发Key>`。上游鉴权可以独立选择 Bearer 或 x-api-key，两种头同时携带不同转发 Key 会被拒绝。管理密钥不能用于代理调用。

目标路径 = 上游路径前缀 + 客户端请求路径。不自动去重：基础地址 `https://up.example/v1` 收到 `/v1/messages` 将请求 `/v1/v1/messages`。查询参数及其顺序保留，业务协议由客户端和上游自行兼容。

WebSocket 使用同样的转发 Key 鉴权和上游配置。浏览器原生 WebSocket 无法随意设置鉴权头，因此第一版不保证这类浏览器调用兼容，不提供查询参数 Key。跨域浏览器预检和 CORS 不自动放宽。

## 缓存与数据

D1 的 config 表只有一行，包含配置 JSON、版本和更新时间。转发 Key 只保存 SHA-256 摘要，上游 Key 用 AES-GCM 加密。上游和转发 Key 各最多 100 个，避免无界扩大配置快照。

默认缓存 30 秒，由 CONFIG_CACHE_TTL_SECONDS 控制（0–3600 秒，0 表示不复用缓存）。每个实例独立缓存，命中时不查询 D1；冷启动、过期时合并同实例并发读取。TTL 不因访问而延长。刷新失败且无有效缓存时返回 503，不继续用过期配置。

管理接口直接读取 D1，使用版本条件更新，冲突返回 409。成功提交后更新当前实例缓存；迟到的旧读取不能覆盖新版本。其他实例在缓存过期后刷新，所以新建或撤销 Key、切换或编辑上游可能需要约一个 TTL 生效。已有 SSE / WebSocket 不迁移或主动断开。

内存不保证常驻，不能理解成“全球每 30 秒只查询一次”。缓存减少配置读取，不缓存业务响应；回源 Fetch 禁用缓存，仍应检查账号级 Cache Rules，避免外部规则缓存 API 响应。

## 登录和密钥轮换

管理 Cookie 使用由 ADMIN_KEY 派生的专用 HMAC 签名，固定 1 小时到期，HttpOnly / Secure / SameSite=Strict；无会话表。退出清除当前浏览器 Cookie，不能单独撤销已复制的 Cookie。轮换 ADMIN_KEY 生效后旧签名失效，转发 Key 不受影响。

转发 Key 明文只创建时显示一次。轮换方式是创建新 Key、更新客户端、撤销旧 Key。撤销遵守缓存延迟。

备份上游需要同时保留 D1 和加密 Secret。**不要直接替换 UPSTREAM_KEY_ENCRYPTION_KEY**：当前未提供批量重加密工具，替换会使已有上游 Key 无法解密；如需更换，应先有备份并制定重加密或重新录入流程。管理员 Secret 与加密 Secret 相互独立。

## 验证

```sh
npm run check
npx wrangler deploy --dry-run
```

测试覆盖凭据隔离、配置缓存、并发加载与版本竞争、上游加密、JSON/非 JSON/二进制/multipart 原样传输、错误和重定向、SSE 分段、WebSocket 文本/二进制/握手失败及连接期间切换。

本地集成使用 Miniflare/workerd 与受控上游，不访问真实中转站或使用生产密钥。发布前仍需用实际 Cloudflare 部署和目标中转站验证 SSE 取消、WebSocket 子协议、长连接和平台限制。

业务体不主动改写，但 Host、逐跳头、平台管理的头、压缩传输及 WebSocket 帧边界不承诺网络字节级一致。部署配置开启 Cloudflare Workers Logs，采样率为 100%，保存调用日志供控制台查询。应用代码不输出密钥、业务请求体、响应体或 WebSocket 消息，D1 不保存日志；Cloudflare 平台自身的日志规则另行适用。

需求与方案：[需求文档](docs/01-需求文档.md) · [设计文档](docs/02-设计文档.md) · [架构文档](docs/03-架构文档.md)。

## 测试上游鉴权

添加或编辑上游时，点击“测试鉴权”分别检测 Bearer 和 x-api-key。检测在上游 URL 后拼接 `/models`，使用两种鉴权请求和无密钥对照，不发起模型生成。仅在无密钥请求被拒绝且带密钥返回有效模型列表时确认通过；公开接口、重定向、限流、超时或不支持该路径均不推断为可用。模型列表通过不代表所有模型的调用权限。

只通过一种方式时自动选中，点击保存才生效；两种都通过或结果不明确时保留当前选择。编辑已有上游可留空 Key 使用已保存的密钥；如果修改了 URL，需要重新填写 Key 才能测试。测试不保存结果、不修改当前上游，也不读取或解析客户端的代理请求。
