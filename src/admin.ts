import { testUpstreamAuth } from './auth-probe';
import { issueSession, requireOrigin, requireSession, sessionCookie } from './auth';
import { getCache } from './cache';
import { decryptAccessKey, decryptKey, encryptAccessKey, encryptKey, hash, randomAccessKey, sameSecret } from './crypto';
import { HttpError, json } from './errors';
import { keyFailoverEnabled, keyUpstreamIds } from './key-routing';
import { clearUpstreamFault, readConfig, writeConfig } from './storage';
import { getUpstreamHealth, upstreamCooldownSeconds } from './upstream-health';
import { authType, baseUrl, field, invalid, managementBody, upstreamKey } from './validation';
import type { AccessKey, Config, Env, Snapshot } from './types';

const notFound = () => new HttpError(404, 'NOT_FOUND', '记录或接口不存在');
const publicUpstream = (u: Config['upstreams'][number]) => ({ id: u.id, name: u.name, baseUrl: u.baseUrl, authType: u.authType, hasKey: true,
  healthRevision: u.healthRevision ?? 0, faultUntil: u.faultUntil ?? 0, faultReason: u.faultReason ?? null });
const publicKey = (key: AccessKey) => ({
  id: key.id, name: key.name, keyPrefix: key.keyPrefix, createdAt: key.createdAt,
  upstreamIds: keyUpstreamIds(key), failoverEnabled: keyFailoverEnabled(key), canReveal: !!key.encryptedKey
});
function keyUpstreams(body: Record<string, unknown>, config: Config, creating = false): string[] | null {
  if (body.upstreamIds !== undefined && body.upstreamId !== undefined) invalid('不能同时提供 upstreamIds 和 upstreamId');
  let value = body.upstreamIds;
  // Accept earlier single-binding clients while storing only the ordered list.
  if (body.upstreamId !== undefined) {
    if (body.upstreamId !== null && (typeof body.upstreamId !== 'string' || !body.upstreamId)) invalid('上游 ID 必须是非空字符串或 null');
    value = body.upstreamId === null ? null : [body.upstreamId];
  }
  if (creating && value === undefined) value = null;
  if (value === null) return null;
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(id => typeof id !== 'string' || !id) || new Set(value).size !== value.length) {
    invalid('请选择 1–100 个不重复的上游，或使用 null 跟随默认上游');
  }
  if (value.some(id => !config.upstreams.some(u => u.id === id))) throw new HttpError(404, 'UPSTREAM_NOT_FOUND', '所选上游不存在，请刷新后重试');
  return value;
}
function keyFailover(value: unknown, ids: string[] | null): boolean {
  if (typeof value !== 'boolean') invalid('故障转移开关必须为布尔值');
  if (value && (ids?.length ?? 0) < 2) invalid('启用故障转移需要至少两个指定上游');
  return value;
}
async function commit(env: Env, before: Snapshot, config: Config): Promise<void> {
  // A no-op is satisfied by the fresh management read. Do not write a new
  // version or extend the proxy cache's TTL when nothing changed.
  if (JSON.stringify(before.config) === JSON.stringify(config)) return;
  const started = Date.now();
  const next = await writeConfig(env, before.version, config);
  getUpstreamHealth(env).sync(getCache(env).publish(next, started));
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
  if (method === 'GET' && ['/snapshot', '/config', '/upstreams', '/keys'].includes(path)) {
    const state = await readConfig(env); // Management never reads the proxy cache.
    if (path === '/upstreams') return json(state.config.upstreams.map(publicUpstream));
    if (path === '/keys') return json(state.config.accessKeys.map(publicKey));
    const config = {
      proxyUrl: new URL(request.url).origin,
      activeUpstreamId: state.config.activeUpstreamId,
      cacheTtlSeconds: Number(env.CONFIG_CACHE_TTL_SECONDS ?? '30'),
      upstreamCooldownSeconds: upstreamCooldownSeconds(env),
      version: state.version
    };
    if (path === '/snapshot') return json({
      config,
      upstreams: state.config.upstreams.map(publicUpstream),
      keys: state.config.accessKeys.map(publicKey)
    });
    return json(config);
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
  const revealMatch = /^\/keys\/([^/]+)\/reveal$/.exec(path);
  if (revealMatch && method === 'POST') {
    const record = (await readConfig(env)).config.accessKeys.find(k => k.id === revealMatch[1]);
    if (!record) throw notFound();
    if (!record.encryptedKey) throw new HttpError(409, 'KEY_NOT_RECOVERABLE', '此旧 Key 只保存了摘要，无法恢复明文；原 Key 仍可使用');
    const key = await decryptAccessKey(env, record.id, record.encryptedKey);
    if (await hash(key) !== record.keyHash) throw new Error('Stored key mismatch');
    return json({ key });
  }
  const upstreamMatch = /^\/upstreams\/([^/]+)$/.exec(path);
  const clearMatch = /^\/upstreams\/([^/]+)\/clear-fault$/.exec(path);
  if (clearMatch && method === 'POST') {
    const started = Date.now();
    const next = await clearUpstreamFault(env, clearMatch[1]);
    if (!next) throw notFound();
    getUpstreamHealth(env).sync(getCache(env).publish(next, started));
    return json(publicUpstream(next.config.upstreams.find(u => u.id === clearMatch[1])!));
  }
  const keyMatch = /^\/keys\/([^/]+)$/.exec(path);
  const known = (path === '/upstreams' && method === 'POST') ||
    (upstreamMatch && (method === 'PATCH' || method === 'DELETE')) ||
    (path === '/active-upstream' && method === 'PUT') ||
    (path === '/keys' && method === 'POST') || (keyMatch && (method === 'PATCH' || method === 'DELETE'));
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
      if (config.accessKeys.some(k => keyUpstreamIds(k)?.includes(u.id))) throw new HttpError(409, 'UPSTREAM_IN_USE', '先从转发 Key 的上游列表中移除此上游再删除');
      config.upstreams = config.upstreams.filter(item => item.id !== u.id);
    } else {
      const old = JSON.stringify([u.baseUrl, u.authType, u.keyVersion, u.keyIv, u.keyCiphertext]);
      if (body.name !== undefined) u.name = field(body.name, '名称');
      if (body.baseUrl !== undefined) u.baseUrl = baseUrl(body.baseUrl, request, env);
      if (body.authType !== undefined) u.authType = authType(body.authType);
      if (body.key !== undefined && body.key !== '') Object.assign(u, await encryptKey(env, u.id, upstreamKey(body.key)));
      if (old !== JSON.stringify([u.baseUrl, u.authType, u.keyVersion, u.keyIv, u.keyCiphertext])) {
        u.healthRevision = (u.healthRevision ?? 0) + 1;
        u.faultUntil = 0;
        u.faultReason = null;
      }
      result = publicUpstream(u);
    }
  } else if (path === '/active-upstream') {
    const id = body.id;
    if (id !== null && (typeof id !== 'string' || !config.upstreams.some(u => u.id === id))) throw notFound();
    config.activeUpstreamId = id as string | null;
  } else if (path === '/keys') {
    if (config.accessKeys.length >= 100) invalid('最多保存 100 个转发 Key');
    const upstreamIds = keyUpstreams(body, config, true);
    const failoverEnabled = keyFailover(body.failoverEnabled === undefined ? (upstreamIds?.length ?? 0) > 1 : body.failoverEnabled, upstreamIds);
    const key = randomAccessKey();
    const keyHash = await hash(key);
    if (config.accessKeys.some(k => k.keyHash === keyHash)) throw new Error('Key collision');
    const id = crypto.randomUUID();
    const record = { id, name: field(body.name, '名称'), keyHash, keyPrefix: key.slice(0, 14), createdAt: new Date().toISOString(),
      upstreamIds, failoverEnabled, encryptedKey: await encryptAccessKey(env, id, key) };
    config.accessKeys.push(record);
    result = { ...publicKey(record), key };
    status = 201;
  } else if (keyMatch) {
    const record = config.accessKeys.find(k => k.id === keyMatch[1]);
    if (!record) throw notFound();
    if (method === 'DELETE') config.accessKeys = config.accessKeys.filter(k => k.id !== record.id);
    else {
      const changesRoutes = body.upstreamIds !== undefined || body.upstreamId !== undefined;
      if (body.name === undefined && !changesRoutes && body.failoverEnabled === undefined) invalid('请提供名称、上游配置或故障转移开关');
      if (body.name !== undefined) record.name = field(body.name, '名称');
      if (changesRoutes) {
        const ids = keyUpstreams(body, config);
        // Preserve unchanged legacy bindings; list order remains significant.
        if (JSON.stringify(keyUpstreamIds(record)) !== JSON.stringify(ids)) {
          record.upstreamIds = ids;
          delete record.upstreamId;
        }
      }
      if (body.failoverEnabled !== undefined) record.failoverEnabled = keyFailover(body.failoverEnabled, keyUpstreamIds(record));
      else if (changesRoutes && record.failoverEnabled && (keyUpstreamIds(record)?.length ?? 0) < 2) record.failoverEnabled = false;
      result = publicKey(record);
    }
  }
  await commit(env, before, config);
  return json(result, status);
}
