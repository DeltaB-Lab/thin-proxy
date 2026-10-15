import { forwardingToken, COOKIE_NAME } from './auth';
import { getCache } from './cache';
import { decryptKey, hash } from './crypto';
import { HttpError } from './errors';
import { isSelf } from './validation';
import type { Env } from './types';

export function targetUrl(base: string, incoming: URL): URL {
  const target = new URL(base);
  target.pathname = target.pathname.replace(/\/+$/, '') + incoming.pathname;
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
  if (!state.keyHashes.has(await hash(token))) throw new HttpError(401, 'INVALID_KEY', '转发 Key 无效或已撤销');
  const upstream = state.config.upstreams.find(u => u.id === state.config.activeUpstreamId);
  if (!upstream) throw new HttpError(409, 'NO_ACTIVE_UPSTREAM', '请先在管理页面选择上游');
  const target = targetUrl(upstream.baseUrl, new URL(request.url));
  if (isSelf(target.hostname, request, env)) throw new HttpError(502, 'PROXY_LOOP', '上游不能指向代理自身');
  const key = await decryptKey(env, upstream);
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const headers = outboundHeaders(request, upgrade);
  headers.set(upstream.authType === 'bearer' ? 'Authorization' : 'x-api-key', upstream.authType === 'bearer' ? `Bearer ${key}` : key);
  // No JSON/text/form parsing, no protocol conversion, no response wrapping.
  // Returning the native Response also preserves its WebSocket upgrade object.
  try {
    return await fetch(target.href, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      signal: request.signal,
      cf: { cacheTtl: -1, cacheEverything: false }
    });
  } catch {
    throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', '上游连接失败');
  }
}
