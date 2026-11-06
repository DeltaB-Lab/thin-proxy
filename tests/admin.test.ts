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
      upstreamId: 'a', encryptedKey: { keyCiphertext: 'private-key-ciphertext', keyIv: 'private-iv', keyVersion: 1 } }]
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
      config: { proxyUrl: origin, activeUpstreamId: 'a', cacheTtlSeconds: 30, version: 7 },
      upstreams: ['a', 'b'].map(id => ({ id, name: id, baseUrl: `https://${id}.example/`, modelCatalogUrl: '', authType: 'bearer', hasKey: true })),
      keys: [{ id: 'k', name: 'Key', keyPrefix: 'relay_prefix', createdAt: '2026-10-15', upstreamId: 'a', enabled: true, canReveal: true }]
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ['/upstreams/a', 'PATCH', { modelCatalogUrl: '' }],
    ['/upstreams/a', 'PATCH', { name: 'a', baseUrl: 'https://a.example/', authType: 'bearer', key: '' }],
    ['/keys/k', 'PATCH', { upstreamId: 'a' }],
    ['/keys/k', 'PATCH', { name: ' Key ' }],
    ['/keys/k', 'PATCH', { enabled: true }],
    ['/keys/k', 'PATCH', { name: 'Key', upstreamId: 'a' }],
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

  it('creates, preserves, edits and clears a catalog URL without changing credentials', async () => {
    const { call, env, row, write } = setup();
    const catalog = 'https://catalog.example/catalog.json?version=2&tag=a&tag=b';
    const created = await (await call('/upstreams', 'POST', {
      name: 'Catalog', baseUrl: 'https://chat.example/v1', modelCatalogUrl: catalog, authType: 'bearer', key: 'test-secret'
    })).json() as any;
    expect(created.modelCatalogUrl).toBe(catalog);
    expect((await getCache(env).get()).config.upstreams.find(u => u.id === created.id)?.modelCatalogUrl).toBe(catalog);
    await call(`/upstreams/${created.id}`, 'PATCH', { name: 'Renamed' });
    expect((await (await call('/snapshot')).json() as any).upstreams.find((u: any) => u.id === created.id).modelCatalogUrl).toBe(catalog);
    const config = JSON.parse(row.config_json);
    const saved = config.upstreams.find((u: any) => u.id === created.id);
    row.config_json = JSON.stringify(config); row.version++;
    await call(`/upstreams/${created.id}`, 'PATCH', { modelCatalogUrl: 'https://other.example/catalog' });
    expect(JSON.parse(row.config_json).upstreams.find((u: any) => u.id === created.id)).toEqual({ ...saved, modelCatalogUrl: 'https://other.example/catalog' });
    await call(`/upstreams/${created.id}`, 'PATCH', { modelCatalogUrl: '' });
    expect((await getCache(env).get()).config.upstreams.find(u => u.id === created.id)?.modelCatalogUrl).toBeUndefined();
    expect((await (await call('/upstreams')).json() as any[]).find(u => u.id === created.id).modelCatalogUrl).toBe('');
    write.mockClear();
    await call(`/upstreams/${created.id}`, 'PATCH', { modelCatalogUrl: null });
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['http://catalog.example/models', 'https://user:pass@catalog.example/models', 'https://catalog.example/#x',
    'https://relay.example/models', 'https://127.1/models', 'https://10.0.0.1/models', 'https://[::1]/models', 42, {}])(
    'rejects invalid catalog destinations without saving: %j', async modelCatalogUrl => {
      const { call, write } = setup();
      await expect(call('/upstreams/a', 'PATCH', { modelCatalogUrl })).rejects.toMatchObject({ status: 400 });
      await expect(call('/upstreams', 'POST', { name: 'Invalid', baseUrl: 'https://chat.example', authType: 'bearer', key: 'test-secret', modelCatalogUrl })).rejects.toMatchObject({ status: 400 });
      expect(write).not.toHaveBeenCalled();
    });

  it.each([undefined, null, 'a'])('does not rewrite unchanged legacy binding %s', async upstreamId => {
    const config = fixture(); delete config.accessKeys[0].upstreamId;
    if (upstreamId !== undefined) config.accessKeys[0].upstreamId = upstreamId;
    const { call, write, row } = setup(config);
    const before = row.config_json;
    const response = await call('/keys/k', 'PATCH', { upstreamId: upstreamId ?? null });
    expect((await response.json() as any).upstreamId).toBe(upstreamId ?? null);
    expect(write).not.toHaveBeenCalled(); expect(row.config_json).toBe(before);
  });

  it('persists a binding change and publishes the committed snapshot without rereading', async () => {
    const { call, write, read, env, row } = setup();
    await call('/keys/k', 'PATCH', { upstreamId: 'b' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(row.version).toBe(8);
    expect((await getCache(env).get()).config.accessKeys[0].upstreamId).toBe('b');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('stops and restores one key, preserving credentials, routes and other keys', async () => {
    const config = fixture(); config.accessKeys.push({...config.accessKeys[0], id: 'other', keyHash: 'other-hash'});
    const {call, row, write, env} = setup(config);
    await getCache(env).get();
    expect(await (await call('/keys/k', 'PATCH', {enabled:false})).json()).toMatchObject({enabled:false});
    expect(JSON.parse(row.config_json)).toEqual({...config, accessKeys:[{...config.accessKeys[0], enabled:false}, config.accessKeys[1]]});
    expect((await getCache(env).get()).keysByHash.get('private-hash')?.enabled).toBe(false);
    expect(await (await call('/keys')).json()).toMatchObject([{id:'k', enabled:false}, {id:'other', enabled:true}]);
    await call('/keys/k', 'PATCH', {enabled:false}); expect(write).toHaveBeenCalledTimes(1);
    await call('/keys/k', 'PATCH', {name:'Renamed', upstreamId:'b'});
    expect(JSON.parse(row.config_json).accessKeys[0].enabled).toBe(false);
    expect(await (await call('/keys/k', 'PATCH', {enabled:true})).json()).toMatchObject({enabled:true, name:'Renamed', upstreamId:'b'});
    expect((await getCache(env).get()).keysByHash.get('private-hash')?.enabled).toBe(true);
    expect(JSON.parse(row.config_json).accessKeys[0].encryptedKey).toEqual(config.accessKeys[0].encryptedKey);
  });

  it('validates and authenticates service status changes before writing', async () => {
    const {call, write} = setup();
    for (const enabled of [null, 'false', 0, [], {}]) {
      await expect(call('/keys/k', 'PATCH', {enabled})).rejects.toMatchObject({status:400});
    }
    await expect(call('/keys/k', 'PATCH', {enabled:false}, false)).rejects.toMatchObject({status:401});
    await expect(call('/keys/missing', 'PATCH', {enabled:false})).rejects.toMatchObject({status:404});
    expect(write).not.toHaveBeenCalled();
    expect(await (await call('/keys', 'POST', {name:'New key'})).json()).toMatchObject({enabled:true});
  });



  it('treats an explicitly supplied upstream secret as a replacement', async () => {
    const { call, write, row } = setup();
    await call('/upstreams/a', 'PATCH', { key: 'replacement-secret' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(row.config_json).not.toContain('replacement-secret');
    expect(JSON.parse(row.config_json).upstreams[0].keyCiphertext).not.toBe('private-upstream-ciphertext');
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
    await expect(call('/keys/k', 'PATCH', { upstreamId: 42 })).rejects.toMatchObject({ status: 400 });
    await expect(call('/active-upstream', 'PUT', { id: 'missing' })).rejects.toMatchObject({ status: 404 });
    expect(write).not.toHaveBeenCalled();
    write.mockResolvedValueOnce({ meta: { changes: 0 } });
    await expect(call('/active-upstream', 'PUT', { id: 'b' })).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect(publish).not.toHaveBeenCalled();
  });
});
