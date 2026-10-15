import { forwardingToken, COOKIE_NAME } from './auth';
import { getCache } from './cache';
import { decryptKey, hash } from './crypto';
import { HttpError } from './errors';
import { keyUpstreamIds } from './key-routing';
import { replayBody, requireConnected } from './replay-body';
import { isSelf } from './validation';
import type { Env } from './types';

export function targetUrl(base: string, incoming: URL): URL {
  const target = new URL(base);
  const prefix = target.pathname.replace(/\/+$/, '');
  const path = prefix.endsWith('/v1') && /^\/v1(?:\/|$)/.test(incoming.pathname)
    ? incoming.pathname.slice(3) : incoming.pathname;
  target.pathname = prefix + path;
  target.search = incoming.search;
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
  const ids = keyUpstreamIds(accessKey) ?? (state.config.activeUpstreamId ? [state.config.activeUpstreamId] : []);
  if (!ids.length) throw new HttpError(409, 'NO_ACTIVE_UPSTREAM', '请为此 Key 指定上游或选择默认上游');
  const timeoutSeconds = Number(env.UPSTREAM_TIMEOUT_SECONDS ?? '30');
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 300) throw new Error('Invalid upstream timeout');
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = !hasBody ? () => undefined : ids.length > 1 ? await replayBody(request) : () => request.body;
  for (const [index, id] of ids.entries()) {
    requireConnected(request.signal);
    const upstream = state.config.upstreams.find(u => u.id === id);
    if (!upstream) throw new HttpError(503, 'CONFIG_UNAVAILABLE', 'Key 指定的上游不存在');
    const target = targetUrl(upstream.baseUrl, new URL(request.url));
    if (isSelf(target.hostname, request, env)) throw new HttpError(502, 'PROXY_LOOP', '上游不能指向代理自身');
    const key = await decryptKey(env, upstream);
    const headers = outboundHeaders(request, upgrade);
    headers.set(upstream.authType === 'bearer' ? 'Authorization' : 'x-api-key', upstream.authType === 'bearer' ? `Bearer ${key}` : key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    const last = index === ids.length - 1;
    let response: Response;
    try {
      response = await fetch(target.href, {
        method: request.method, headers, body: body(), redirect: 'manual',
        signal: AbortSignal.any([request.signal, controller.signal]),
        cf: { cacheTtl: -1, cacheEverything: false }
      });
    } catch {
      requireConnected(request.signal);
      if (!last) continue;
      if (controller.signal.aborted) throw new HttpError(504, 'UPSTREAM_TIMEOUT', '上游响应超时');
      throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', '上游连接失败');
    } finally {
      clearTimeout(timer);
    }
    if (request.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      requireConnected(request.signal);
    }
    const failed = [401, 403, 408, 429].includes(response.status) || response.status >= 500;
    // Once accepted, return the native response, including SSE and WebSocket.
    // Never retry a response-body error or splice two upstream streams together.
    if (!failed || last) return response;
    void response.body?.cancel().catch(() => {});
    controller.abort();
  }
  throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', '没有可用上游');
}
