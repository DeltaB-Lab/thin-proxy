import { testUpstreamAuth } from './auth-probe';
import { issueSession, requireOrigin, requireSession, sessionCookie } from './auth';
import { getCache } from './cache';
import { decryptAccessKey, decryptKey, encryptAccessKey, encryptKey, hash, randomAccessKey, sameSecret, validateAdminSecret } from './crypto';
import { HttpError, json } from './errors';
import { requireLoginAllowance } from './login-limit';
import { readConfig, writeConfig } from './storage';
import { authType, baseUrl, field, invalid, managementBody, modelCatalogUrl, upstreamKey } from './validation';
import type { AccessKey, Config, Env, Snapshot } from './types';

const notFound = () => new HttpError(404, 'NOT_FOUND', '记录或接口不存在');
const publicUpstream = (u: Config['upstreams'][number]) => ({ id: u.id, name: u.name, baseUrl: u.baseUrl, authType: u.authType, hasKey: true,
  modelCatalogUrl: u.modelCatalogUrl ?? '' });
const publicKey = (key: AccessKey) => ({
  id: key.id, name: key.name, keyPrefix: key.keyPrefix, createdAt: key.createdAt,
  enabled: key.enabled !== false, upstreamId: key.upstreamId ?? null, canReveal: !!key.encryptedKey
});
function keyUpstream(value: unknown, config: Config): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value) invalid('上游 ID 必须是非空字符串或 null');
  if (!config.upstreams.some(u => u.id === value)) throw new HttpError(404, 'UPSTREAM_NOT_FOUND', '所选上游不存在，请刷新后重试');
  return value;
}
async function commit(env: Env, before: Snapshot, config: Config): Promise<void> {
  // A no-op is satisfied by the fresh management read. Do not write a new
  // version or extend the proxy cache's TTL when nothing changed.
  if (JSON.stringify(before.config) === JSON.stringify(config)) return;
  const started = Date.now();
  const next = await writeConfig(env, before.version, config);
  getCache(env).publish(next, started);
}
export async function admin(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname.slice('/_relay/api'.length);
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') requireOrigin(request);
  if (path === '/session' && method === 'POST') {
    validateAdminSecret(env.ADMIN_KEY);
    await requireLoginAllowance(request, env);
    const body = await managementBody(request);
    const key = field(body.key, '管理密钥', 1024);
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
  const keyMatch = /^\/keys\/([^/]+)$/.exec(path);
  const known = (path === '/upstreams' && method === 'POST') ||
    (upstreamMatch && (method === 'PATCH' || method === 'DELETE')) ||
    (path === '/active-upstream' && method === 'PUT') ||
    (path === '/keys' && method === 'POST') || (keyMatch && (method === 'PATCH' || method === 'DELETE'));
  if (!known) throw notFound();
  const body = method === 'DELETE' ? {} : await managementBody(request);
  if (body.upstreamIds !== undefined || body.failoverEnabled !== undefined) {
    invalid('已移除故障转移，请使用 upstreamId 指定一个上游或传入 null 跟随默认上游');
  }
  const before = await readConfig(env);
  const config = structuredClone(before.config);
  let result: unknown = { ok: true };
  let status = 200;
  if (path === '/upstreams' && method === 'POST') {
    if (config.upstreams.length >= 100) invalid('最多保存 100 个上游');
    const id = crypto.randomUUID();
    const u = { id, name: field(body.name, '名称'), baseUrl: baseUrl(body.baseUrl, request, env),
      modelCatalogUrl: modelCatalogUrl(body.modelCatalogUrl, request, env),
      authType: authType(body.authType), ...await encryptKey(env, id, upstreamKey(body.key)) };
    config.upstreams.push(u);
    result = publicUpstream(u);
    status = 201;
  } else if (upstreamMatch) {
    const u = config.upstreams.find(u => u.id === upstreamMatch[1]);
    if (!u) throw notFound();
    if (method === 'DELETE') {
      if (u.id === config.activeUpstreamId) throw new HttpError(409, 'ACTIVE_UPSTREAM', '先切换或取消当前上游再删除');
      if (config.accessKeys.some(k => k.upstreamId === u.id)) throw new HttpError(409, 'UPSTREAM_IN_USE', '先修改绑定此上游的转发 Key 再删除');
      config.upstreams = config.upstreams.filter(item => item.id !== u.id);
    } else {
      if (body.name !== undefined) u.name = field(body.name, '名称');
      if (body.baseUrl !== undefined) u.baseUrl = baseUrl(body.baseUrl, request, env);
      if (body.modelCatalogUrl !== undefined) {
        const catalog = modelCatalogUrl(body.modelCatalogUrl, request, env);
        if (catalog) u.modelCatalogUrl = catalog; else delete u.modelCatalogUrl;
      }
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
    const upstreamId = keyUpstream(body.upstreamId ?? null, config);
    const key = randomAccessKey();
    const keyHash = await hash(key);
    if (config.accessKeys.some(k => k.keyHash === keyHash)) throw new Error('Key collision');
    const id = crypto.randomUUID();
    const record = { id, name: field(body.name, '名称'), keyHash, keyPrefix: key.slice(0, 14), createdAt: new Date().toISOString(),
      upstreamId, enabled: true, encryptedKey: await encryptAccessKey(env, id, key) };
    config.accessKeys.push(record);
    result = { ...publicKey(record), key };
    status = 201;
  } else if (keyMatch) {
    const record = config.accessKeys.find(k => k.id === keyMatch[1]);
    if (!record) throw notFound();
    if (method === 'DELETE') config.accessKeys = config.accessKeys.filter(k => k.id !== record.id);
    else {
      if (body.name === undefined && body.upstreamId === undefined && body.enabled === undefined) invalid('请提供名称、上游或服务状态');
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') invalid('服务状态必须为布尔值');
        if ((record.enabled !== false) !== body.enabled) record.enabled = body.enabled;
      }
      if (body.name !== undefined) record.name = field(body.name, '名称');
      if (body.upstreamId !== undefined) record.upstreamId = keyUpstream(body.upstreamId, config);
      result = publicKey(record);
    }
  }
  await commit(env, before, config);
  return json(result, status);
}
