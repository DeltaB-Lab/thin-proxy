import { testUpstreamAuth } from './auth-probe';
import { issueSession, requireOrigin, requireSession, sessionCookie } from './auth';
import { getCache } from './cache';
import { decryptKey, encryptKey, hash, randomToken, sameSecret } from './crypto';
import { HttpError, json } from './errors';
import { readConfig, writeConfig } from './storage';
import { authType, baseUrl, field, invalid, managementBody, upstreamKey } from './validation';
import type { Config, Env, Snapshot } from './types';

const notFound = () => new HttpError(404, 'NOT_FOUND', '记录或接口不存在');
const publicUpstream = (u: Config['upstreams'][number]) => ({ id: u.id, name: u.name, baseUrl: u.baseUrl, authType: u.authType, hasKey: true });
async function commit(env: Env, before: Snapshot, config: Config): Promise<void> {
  const started = Date.now();
  const next = await writeConfig(env, before.version, config);
  getCache(env).publish(next, started);
}
export async function admin(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname.slice('/_relay/api'.length);
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') requireOrigin(request);
  if (path === '/session' && method === 'POST') {
    const body = await managementBody(request);
    const key = field(body.key, '管理密钥', 1024);
    if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 32) throw new Error('Admin secret not configured');
    if (!await sameSecret(key, env.ADMIN_KEY)) throw new HttpError(401, 'INVALID_ADMIN_KEY', '管理密钥错误');
    const response = json({ ok: true });
    response.headers.set('Set-Cookie', sessionCookie(await issueSession(env.ADMIN_KEY)));
    return response;
  }
  await requireSession(request, env.ADMIN_KEY);
  if (path === '/session' && method === 'DELETE') {
    const response = json({ ok: true });
    response.headers.set('Set-Cookie', sessionCookie('', true));
    return response;
  }
  if (method === 'GET' && ['/config', '/upstreams', '/keys'].includes(path)) {
    const state = await readConfig(env); // Management never reads the proxy cache.
    if (path === '/upstreams') return json(state.config.upstreams.map(publicUpstream));
    if (path === '/keys') return json(state.config.accessKeys.map(({ keyHash: _, ...metadata }) => metadata));
    return json({
      proxyUrl: new URL(request.url).origin,
      activeUpstreamId: state.config.activeUpstreamId,
      cacheTtlSeconds: Number(env.CONFIG_CACHE_TTL_SECONDS ?? '30'),
      version: state.version
    });
  }
  if (path === '/test-auth' && method === 'POST') {
    const body = await managementBody(request);
    const target = baseUrl(body.baseUrl, request, env);
    let key: string;
    if (body.key !== undefined && body.key !== '') key = upstreamKey(body.key);
    else {
      const id = field(body.id, '上游 ID');
      const saved = (await readConfig(env)).config.upstreams.find(u => u.id === id);
      if (!saved) throw notFound();
      if (target !== saved.baseUrl) invalid('地址已修改，请重新填写 Key 后测试');
      key = await decryptKey(env, saved);
    }
    return json(await testUpstreamAuth(target, key));
  }
  const upstreamMatch = /^\/upstreams\/([^/]+)$/.exec(path);
  const keyMatch = /^\/keys\/([^/]+)$/.exec(path);
  const known = (path === '/upstreams' && method === 'POST') ||
    (upstreamMatch && (method === 'PATCH' || method === 'DELETE')) ||
    (path === '/active-upstream' && method === 'PUT') ||
    (path === '/keys' && method === 'POST') || (keyMatch && method === 'DELETE');
  if (!known) throw notFound();
  const body = method === 'DELETE' ? {} : await managementBody(request);
  const before = await readConfig(env);
  const config = structuredClone(before.config);
  let result: unknown = { ok: true };
  let status = 200;
  if (path === '/upstreams' && method === 'POST') {
    if (config.upstreams.length >= 100) invalid('最多保存 100 个上游');
    const id = crypto.randomUUID();
    const u = { id, name: field(body.name, '名称'), baseUrl: baseUrl(body.baseUrl, request, env),
      authType: authType(body.authType), ...await encryptKey(env, id, upstreamKey(body.key)) };
    config.upstreams.push(u);
    result = publicUpstream(u);
    status = 201;
  } else if (upstreamMatch) {
    const u = config.upstreams.find(u => u.id === upstreamMatch[1]);
    if (!u) throw notFound();
    if (method === 'DELETE') {
      if (u.id === config.activeUpstreamId) throw new HttpError(409, 'ACTIVE_UPSTREAM', '先切换或取消当前上游再删除');
      config.upstreams = config.upstreams.filter(item => item.id !== u.id);
    } else {
      if (body.name !== undefined) u.name = field(body.name, '名称');
      if (body.baseUrl !== undefined) u.baseUrl = baseUrl(body.baseUrl, request, env);
      if (body.authType !== undefined) u.authType = authType(body.authType);
      if (body.key !== undefined && body.key !== '') Object.assign(u, await encryptKey(env, u.id, upstreamKey(body.key)));
      result = publicUpstream(u);
    }
  } else if (path === '/active-upstream') {
    const id = body.id;
    if (id !== null && (typeof id !== 'string' || !config.upstreams.some(u => u.id === id))) throw notFound();
    config.activeUpstreamId = id as string | null;
  } else if (path === '/keys') {
    if (config.accessKeys.length >= 100) invalid('最多保存 100 个转发 Key');
    const key = `relay_${randomToken()}`;
    const keyHash = await hash(key);
    if (config.accessKeys.some(k => k.keyHash === keyHash)) throw new Error('Key collision');
    const record = { id: crypto.randomUUID(), name: field(body.name, '名称'), keyHash, keyPrefix: key.slice(0, 14), createdAt: new Date().toISOString() };
    config.accessKeys.push(record);
    const { keyHash: _, ...metadata } = record;
    result = { ...metadata, key };
    status = 201;
  } else if (keyMatch) {
    if (!config.accessKeys.some(k => k.id === keyMatch[1])) throw notFound();
    config.accessKeys = config.accessKeys.filter(k => k.id !== keyMatch[1]);
  }
  await commit(env, before, config);
  return json(result, status);
}
