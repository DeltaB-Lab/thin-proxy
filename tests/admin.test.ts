import { beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '../src/admin';
import { issueSession } from '../src/auth';
import { getCache } from '../src/cache';
import type { Config, Env } from '../src/types';

const origin = 'https://relay.example';
const secret = 'admin-test-only-secret-at-least-32-characters';
let cookie: string;
beforeAll(async () => { cookie = `relay_admin=${await issueSession(secret)}`; });

function fixture(): Config {
  return {
    activeUpstreamId: 'a',
    upstreams: ['a', 'b'].map(id => ({ id, name: id, baseUrl: `https://${id}.example/`, authType: 'bearer',
      keyCiphertext: 'private-upstream-ciphertext', keyIv: 'private-iv', keyVersion: 1 })),
    accessKeys: [{ id: 'k', name: 'Key', keyPrefix: 'relay_prefix', keyHash: 'private-hash', createdAt: '2026-10-15',
      upstreamIds: ['a', 'b'], encryptedKey: { keyCiphertext: 'private-key-ciphertext', keyIv: 'private-iv', keyVersion: 1 } }]
  };
}

function setup(config = fixture()) {
  const row = { version: 7, config_json: JSON.stringify(config), updated_at: 'original' };
  const read = vi.fn(async () => ({ ...row }));
  const write = vi.fn(async (json: string, updatedAt: string, expectedVersion: number) => {
    if (expectedVersion !== row.version) return { meta: { changes: 0 } };
    row.config_json = json; row.updated_at = updatedAt; row.version++;
    return { meta: { changes: 1 } };
  });
  const env = {
    ADMIN_KEY: secret, UPSTREAM_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), CONFIG_CACHE_TTL_SECONDS: '30',
    DB: { withSession() { return this; }, prepare() {
      return { first: read, bind: (json: string, updatedAt: string, version: number) => ({ run: () => write(json, updatedAt, version) }) };
    } }
  } as unknown as Env;
  const call = (path: string, method = 'GET', body?: unknown, authenticated = true) => admin(new Request(origin + '/_relay/api' + path, {
    method, headers: { Origin: origin, ...(authenticated ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
  return { row, read, write, env, call };
}

describe('management snapshot and write minimization', () => {
  it('authenticates the snapshot before reading, then returns only public fields with one read', async () => {
    const { call, read, write } = setup();
    await expect(call('/snapshot', 'GET', undefined, false)).rejects.toMatchObject({ status: 401 });
    expect(read).not.toHaveBeenCalled();
    const response = await call('/snapshot');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      config: { proxyUrl: origin, activeUpstreamId: 'a', cacheTtlSeconds: 30, upstreamCooldownSeconds: 1800, version: 7 },
      upstreams: ['a', 'b'].map(id => ({ id, name: id, baseUrl: `https://${id}.example/`, authType: 'bearer', hasKey: true, healthRevision: 0, faultUntil: 0, faultReason: null })),
      keys: [{ id: 'k', name: 'Key', keyPrefix: 'relay_prefix', createdAt: '2026-10-15', upstreamIds: ['a', 'b'], canReveal: true }]
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ['/upstreams/a', 'PATCH', { name: 'a', baseUrl: 'https://a.example/', authType: 'bearer', key: '' }],
    ['/keys/k', 'PATCH', { upstreamIds: ['a', 'b'] }],
    ['/keys/k', 'PATCH', { name: ' Key ' }],
    ['/keys/k', 'PATCH', { name: 'Key', upstreamIds: ['a', 'b'] }],
    ['/active-upstream', 'PUT', { id: 'a' }]
  ])('does not write or publish unchanged %s', async (path, method, body) => {
    const { call, env, read, write, row } = setup();
    const publish = vi.spyOn(getCache(env), 'publish');
    expect((await call(path as string, method as string, body)).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(row.version).toBe(7); expect(row.updated_at).toBe('original');
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'a'])('does not rewrite unchanged legacy binding %s', async upstreamId => {
    const config = fixture(); delete config.accessKeys[0].upstreamIds;
    if (upstreamId !== undefined) config.accessKeys[0].upstreamId = upstreamId;
    const { call, write, row } = setup(config);
    const before = row.config_json;
    const response = await call('/keys/k', 'PATCH', { upstreamIds: upstreamId ? [upstreamId] : null });
    expect((await response.json() as any).upstreamIds).toEqual(upstreamId ? [upstreamId] : null);
    expect(write).not.toHaveBeenCalled(); expect(row.config_json).toBe(before);
  });

  it('persists an order change and publishes the committed snapshot without rereading', async () => {
    const { call, write, read, env, row } = setup();
    await call('/keys/k', 'PATCH', { upstreamIds: ['b', 'a'] });
    expect(write).toHaveBeenCalledTimes(1);
    expect(row.version).toBe(8);
    expect((await getCache(env).get()).config.accessKeys[0].upstreamIds).toEqual(['b', 'a']);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('treats an explicitly supplied upstream secret as a replacement', async () => {
    const { call, write, row } = setup();
    await call('/upstreams/a', 'PATCH', { key: 'replacement-secret' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(row.config_json).not.toContain('replacement-secret');
    expect(JSON.parse(row.config_json).upstreams[0].keyCiphertext).not.toBe('private-upstream-ciphertext');
    expect(JSON.parse(row.config_json).upstreams[0]).toMatchObject({healthRevision: 1, faultUntil: 0, faultReason: null});
  });

  it('preserves health on name and route edits, and fences it on destination or auth edits', async () => {
    const config = fixture(); Object.assign(config.upstreams[0], {healthRevision: 5, faultUntil: 9999999999999, faultReason: 'HTTP 503'});
    const {call, row} = setup(config);
    await call('/upstreams/a', 'PATCH', {name: 'renamed'});
    await call('/keys/k', 'PATCH', {upstreamIds: ['b','a']});
    expect(JSON.parse(row.config_json).upstreams[0]).toMatchObject({healthRevision: 5, faultUntil: 9999999999999});
    await call('/upstreams/a', 'PATCH', {baseUrl: 'https://changed.example/'});
    expect(JSON.parse(row.config_json).upstreams[0]).toMatchObject({healthRevision: 6, faultUntil: 0, faultReason: null});
    await call('/upstreams/a', 'PATCH', {authType: 'x-api-key'});
    expect(JSON.parse(row.config_json).upstreams[0].healthRevision).toBe(7);
  });

  it('compares against fresh D1 state even when the proxy cache already matches the request', async () => {
    const { call, env, row, read, write } = setup();
    await getCache(env).get();
    const newer = fixture(); newer.activeUpstreamId = 'b';
    row.config_json = JSON.stringify(newer); row.version = 8;
    await call('/active-upstream', 'PUT', { id: 'a' });
    expect(read).toHaveBeenCalledTimes(2); expect(write).toHaveBeenCalledTimes(1);
    expect(row.version).toBe(9); expect(JSON.parse(row.config_json).activeUpstreamId).toBe('a');
  });

  it('retains validation and optimistic conflict handling without publishing failed writes', async () => {
    const { call, env, write } = setup();
    const publish = vi.spyOn(getCache(env), 'publish');
    await expect(call('/keys/k', 'PATCH', { upstreamIds: ['a', 'a'] })).rejects.toMatchObject({ status: 400 });
    await expect(call('/active-upstream', 'PUT', { id: 'missing' })).rejects.toMatchObject({ status: 404 });
    expect(write).not.toHaveBeenCalled();
    write.mockResolvedValueOnce({ meta: { changes: 0 } });
    await expect(call('/active-upstream', 'PUT', { id: 'b' })).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect(publish).not.toHaveBeenCalled();
  });
});
