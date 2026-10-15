# thin-proxy

一个部署在 Cloudflare Workers 上的轻量 API 反向代理，使用 D1 保存配置。客户端固定代理地址和转发 Key，在网页中切换上游地址与密钥，无需反复修改客户端。

## 怎么用

1. 部署后打开 `https://你的域名/_relay/`，使用 `ADMIN_KEY` 登录。
2. 添加上游 HTTPS 地址、上游 Key 和鉴权方式（Bearer 或 x-api-key），设为当前上游。
3. 创建转发 Key，填入客户端：

```text
Base URL: https://你的域名
API Key: relay_...（网页创建的转发 Key）
```

客户端需要 `/v1` 时，在 Base URL 后加 `/v1`。上游路径前缀与请求路径直接拼接，不自动去重，避免两边重复填写 `/v1`。

支持通过 `Authorization: Bearer <转发 Key>` 或 `x-api-key: <转发 Key>` 调用；管理密钥不能用于转发。所有转发 Key 共用当前上游，配置变更默认最多约 30 秒传播到其他实例，已有长连接继续使用原上游。

## 做什么、不做什么

- **支持** HTTP、流式响应、SSE 和 WebSocket；业务请求体、上游响应体和 WebSocket 消息不解析、不改写、不重新序列化。
- **处理** 目标 URL、转发 Key 校验、上游鉴权替换，以及连接相关 headers 和管理 Cookie 清理。管理接口会解析 JSON；代理自身错误会生成 JSON 响应。
- **不做** 模型映射、协议转换、自动重试、故障切换、负载均衡或自动跟随重定向，客户端与上游需使用兼容协议。
- **不提供** 多用户、计费、用量统计、对话存储或业务内容日志；Cloudflare 平台调用日志另行适用。
- **不自动放宽 CORS**，不支持通过 URL 查询参数传 Key；浏览器原生 WebSocket 无法自定义鉴权头的场景不保证兼容。

透传指应用层内容不改写，不保证底层网络分块、压缩或 WebSocket 帧边界一致。

## 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/DeltaB-Lab/thin-proxy)

**按钮要求公开仓库；本仓库目前为私有，暂不能通过该按钮部署。** 发布为公开仓库后，还需适配自己的账号、域名、两个 Secret 和 D1 初始化。当前手动部署及按钮准备步骤见[部署文档](docs/04-自动部署.md)。

## 本地运行

需要 Node.js 22.12+。

```sh
npm ci
npm run init:local
npm run db:local
npm run dev
```

打开 `http://localhost:8787/_relay/`，使用生成的 `.env` 中的 `ADMIN_KEY` 登录。请保管好 `.env`，不要提交密钥。

更多说明：[需求](docs/01-需求文档.md) · [设计](docs/02-设计文档.md) · [架构](docs/03-架构文档.md)。
