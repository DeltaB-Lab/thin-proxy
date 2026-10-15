import { forwardingToken, COOKIE_NAME } from './auth';
import { getCache } from './cache';
import { decryptKey, hash } from './crypto';
import { HttpError } from './errors';
import { recordUpstreamFault } from './storage';
import { keyUpstreamIds } from './key-routing';
import { getUpstreamHealth, upstreamCooldownSeconds } from './upstream-health';
import { isSelf } from './validation';
import type { Env } from './types';

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
export async function proxy(request: Request, env: Env, context?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
  const token = forwardingToken(request);
  const state = await getCache(env).get();
  const accessKey = state.keysByHash.get(await hash(token));
  if (!accessKey) throw new HttpError(401, 'INVALID_KEY', '转发 Key 无效或已撤销');
  const ids = keyUpstreamIds(accessKey) ?? (state.config.activeUpstreamId ? [state.config.activeUpstreamId] : []);
  if (!ids.length) throw new HttpError(409, 'NO_ACTIVE_UPSTREAM', '请为此 Key 指定上游或选择默认上游');
  const timeoutSeconds = Number(env.UPSTREAM_TIMEOUT_SECONDS ?? '30');
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 300) throw new Error('Invalid upstream timeout');
  const cooldownMs = upstreamCooldownSeconds(env) * 1000;
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  requireConnected(request.signal);
  const attempt = getUpstreamHealth(env).select(state, ids, cooldownMs, timeoutSeconds * 1000);
  const fail = async (reason: string) => {
    if (!attempt.finish('failed')) return;
    const started = Date.now();
    const persist = (async () => {
      try {
        const next = await recordUpstreamFault(env, attempt.upstream.id, attempt.upstream.healthRevision ?? 0, cooldownMs / 1000, reason);
        if (next) {
          const published = getCache(env).publish(next, started);
          getUpstreamHealth(env).sync(published);
        }
        // Zero matched rows are expected: never retry an old request with a new revision.
      } catch {
        console.error('UPSTREAM_FAULT_PERSIST_FAILED', { upstreamId: attempt.upstream.id });
      }
    })();
    if (context) context.waitUntil(persist);
    else await persist;
  };
  try {
    const { upstream } = attempt;
    const target = targetUrl(upstream.baseUrl, new URL(request.url));
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
      await fail(controller.signal.aborted ? 'timeout' : 'connection');
      if (controller.signal.aborted) throw new HttpError(504, 'UPSTREAM_TIMEOUT', '上游响应超时');
      throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', '上游连接失败');
    } finally {
      clearTimeout(timer);
    }
    if (request.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      requireConnected(request.signal);
    }
    const failed = [401, 403, 408, 429].includes(response.status) || (response.status >= 500 && response.status <= 599);
    if (failed) await fail(`HTTP ${response.status}`);
    else attempt.finish('healthy');
    // Return even failed responses untouched. Only a later client request can use another upstream.
    return response;
  } finally {
    // Release a probe after cancellation or local configuration/decryption errors, without penalizing the upstream.
    attempt.finish('cancelled');
  }
}
