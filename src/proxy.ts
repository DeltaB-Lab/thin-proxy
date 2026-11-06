import { forwardingToken, COOKIE_NAME } from './auth';
import { getCache } from './cache';
import { decryptKey, hash } from './crypto';
import { HttpError } from './errors';
import { isSelf } from './validation';
import type { Env, Upstream } from './types';

const MODEL_CATALOG_PATH = '/backend-api/codex/models';

function requireConnected(signal: AbortSignal): void {
  if (signal.aborted) throw new HttpError(499, 'CLIENT_CLOSED_REQUEST', '客户端已取消请求');
}

export function targetUrl(base: string, incoming: URL): URL {
  const target = new URL(base);
  const prefix = target.pathname.replace(/\/+$/, '');
  const path = prefix.endsWith('/v1') && /^\/v1(?:\/|$)/.test(incoming.pathname)
    ? incoming.pathname.slice(3) : incoming.pathname;
  target.pathname = prefix + path;
  target.search = incoming.search;
  return target;
}
export function upstreamTargetUrl(upstream: Pick<Upstream, 'baseUrl' | 'modelCatalogUrl'>, incoming: URL): URL {
  if (incoming.pathname !== MODEL_CATALOG_PATH || !upstream.modelCatalogUrl) return targetUrl(upstream.baseUrl, incoming);
  const target = new URL(upstream.modelCatalogUrl);
  // Preserve raw query encoding and repeated values; configured names take precedence.
  const configured = new Set(target.searchParams.keys());
  const forwarded = incoming.search.slice(1).split('&').filter(part => {
    const name = new URLSearchParams(part).keys().next().value;
    return part && (name === undefined || !configured.has(name));
  }).join('&');
  if (forwarded) target.search = target.search ? `${target.search}&${forwarded}` : `?${forwarded}`;
  return target;
}
function outboundHeaders(request: Request, upgrade: boolean): Headers {
  const headers = new Headers(request.headers);
  if (!upgrade) {
    const nominated = (headers.get('Connection') ?? '').split(',').map(h => h.trim()).filter(Boolean);
    for (const h of [...nominated, 'Connection', 'Keep-Alive', 'Transfer-Encoding', 'TE', 'Trailer', 'Upgrade']) headers.delete(h);
  }
  for (const h of ['Host', 'Authorization', 'x-api-key', 'Proxy-Authorization', 'Proxy-Connection']) headers.delete(h);
  const cookies = headers.get('Cookie');
  if (cookies) {
    const kept = cookies.split(';').filter(c => c.trim().split('=', 1)[0] !== COOKIE_NAME).join(';');
    if (kept.trim()) headers.set('Cookie', kept); else headers.delete('Cookie');
  }
  return headers;
}
export async function proxy(request: Request, env: Env): Promise<Response> {
  const token = forwardingToken(request);
  const state = await getCache(env).get();
  const accessKey = state.keysByHash.get(await hash(token));
  if (!accessKey) throw new HttpError(401, 'INVALID_KEY', '转发 Key 无效或已撤销');
  if (accessKey.enabled === false) throw new HttpError(403, 'KEY_DISABLED', '此转发 Key 已停止服务');
  const id = accessKey.upstreamId ?? state.config.activeUpstreamId;
  if (!id) throw new HttpError(409, 'NO_ACTIVE_UPSTREAM', '请为此 Key 指定上游或选择默认上游');
  const timeoutSeconds = Number(env.UPSTREAM_TIMEOUT_SECONDS ?? '300');
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 300) throw new Error('Invalid upstream timeout');
  const incoming = new URL(request.url);
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  requireConnected(request.signal);
  const upstream = state.config.upstreams.find(item => item.id === id);
  if (!upstream) throw new HttpError(503, 'CONFIG_UNAVAILABLE', 'Key 指定的上游不存在');
  const target = upstreamTargetUrl(upstream, incoming);
  if (isSelf(target.hostname, request, env)) throw new HttpError(502, 'PROXY_LOOP', '上游不能指向代理自身');
  const key = await decryptKey(env, upstream);
  const headers = outboundHeaders(request, upgrade);
  headers.set(upstream.authType === 'bearer' ? 'Authorization' : 'x-api-key', upstream.authType === 'bearer' ? `Bearer ${key}` : key);
  requireConnected(request.signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  let response: Response;
  try {
    response = await fetch(target.href, {
      method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual',
      signal: AbortSignal.any([request.signal, controller.signal]),
      cf: { cacheTtl: -1, cacheEverything: false }
    });
  } catch {
    requireConnected(request.signal);
    if (controller.signal.aborted) throw new HttpError(504, 'UPSTREAM_TIMEOUT', '上游响应超时');
    throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', '上游连接失败');
  } finally {
    clearTimeout(timer);
  }
  if (request.signal.aborted) {
    void response.body?.cancel().catch(() => {});
    requireConnected(request.signal);
  }
  // The proxy never changes configuration or records request health.
  return response;
}
