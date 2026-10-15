import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { clearUpstreamFault, readConfig, recordUpstreamFault, writeConfig } from '../src/storage';
import { ConfigCache } from '../src/cache';
import { UpstreamHealth } from '../src/upstream-health';
import type { Config, Env } from '../src/types';

let mf: Miniflare;
let env: Env;
const initial: Config = { activeUpstreamId: 'a', accessKeys: [], upstreams: ['a', 'b'].map(id => ({
  id, name: id, baseUrl: `https://${id}.example`, authType: 'bearer', keyVersion: 1, keyIv: 'iv', keyCiphertext: 'cipher'
})) };
const upstream = async () => (await readConfig(env)).config.upstreams[0];
beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-08-06', d1Databases: { DB: 'health-test' } });
  env = { DB: await mf.getD1Database('DB') } as unknown as Env;
  for (const sql of (await readFile('migrations/0001_config.sql', 'utf8')).split(';').filter(s => s.trim())) await env.DB.prepare(sql).run();
}, 60_000);
beforeEach(async () => {
  await env.DB.prepare('UPDATE config SET config_json = ?, version = 1, updated_at = ? WHERE id = 1').bind(JSON.stringify(initial), 'initial').run();
});
afterAll(async () => { await mf?.dispose(); });

describe('D1 atomic upstream health updates', () => {
  it('accepts exactly one concurrent report and never renews the deadline from stale reports', async () => {
    const outcomes = await Promise.all(Array.from({length: 10}, () => recordUpstreamFault(env, 'a', 0, 1800, 'HTTP 503')));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const before = await readConfig(env);
    expect(before.version).toBe(2);
    expect(before.config.upstreams[0]).toMatchObject({healthRevision: 1, faultReason: 'HTTP 503'});
    expect(before.config.upstreams[0].faultUntil! - Date.now()).toBeGreaterThan(1_798_000);
    expect(await recordUpstreamFault(env, 'a', 0, 3600, 'timeout')).toBeNull();
    expect(await recordUpstreamFault(env, 'a', 1, 3600, 'timeout')).toBeNull();
    expect(await readConfig(env)).toEqual(before);
  });
  it('fences stale failures after clear, even when clearing an already healthy upstream', async () => {
    await recordUpstreamFault(env, 'a', 0, 1800, 'timeout');
    const cleared = await clearUpstreamFault(env, 'a');
    expect(cleared!.config.upstreams[0]).toMatchObject({healthRevision: 2, faultUntil: 0, faultReason: null});
    for (const old of [0, 1]) expect(await recordUpstreamFault(env, 'a', old, 1800, 'timeout')).toBeNull();
    await clearUpstreamFault(env, 'a');
    expect((await upstream()).healthRevision).toBe(3);
    expect(await recordUpstreamFault(env, 'a', 2, 1800, 'timeout')).toBeNull();
    expect(await recordUpstreamFault(env, 'a', 3, 1800, 'HTTP 429')).not.toBeNull();
  });
  it('only allows the current generation to start another round after expiry', async () => {
    await recordUpstreamFault(env, 'a', 0, 1800, 'timeout');
    const expired = await readConfig(env); expired.config.upstreams[0].faultUntil = 1;
    await writeConfig(env, expired.version, expired.config);
    expect(await recordUpstreamFault(env, 'a', 0, 1800, 'timeout')).toBeNull();
    expect(await recordUpstreamFault(env, 'a', 1, 1800, 'connection')).not.toBeNull();
    expect((await upstream()).healthRevision).toBe(2);
  });
  it('patches by ID after reorder and prevents stale administrative snapshots overwriting faults', async () => {
    const old = await readConfig(env);
    const reordered = structuredClone(old.config); reordered.upstreams.reverse(); reordered.upstreams[0].name = 'new name';
    await writeConfig(env, old.version, reordered);
    await recordUpstreamFault(env, 'a', 0, 1800, 'timeout');
    const current = await readConfig(env);
    expect(current.config.upstreams[0]).toEqual(reordered.upstreams[0]);
    expect(current.config.upstreams[1]).toMatchObject({id: 'a', healthRevision: 1});
    await expect(writeConfig(env, old.version, old.config)).rejects.toMatchObject({code: 'VERSION_CONFLICT'});
    expect(await readConfig(env)).toEqual(current);
    expect(await clearUpstreamFault(env, 'deleted')).toBeNull();
    expect(await recordUpstreamFault(env, 'deleted', 0, 1800, 'timeout')).toBeNull();
  });
  it('propagates through independent caches and clears local cooldown when a newer revision arrives', async () => {
    let now = Date.now();
    const a = new ConfigCache(() => readConfig(env), 30_000, () => now);
    const b = new ConfigCache(() => readConfig(env), 30_000, () => now);
    const healthA = new UpstreamHealth(() => now); const healthB = new UpstreamHealth(() => now);
    const requestA = healthA.select(await a.get(), ['a'], 1_800_000, 30_000);
    const requestB = healthB.select(await b.get(), ['a'], 1_800_000, 30_000);
    requestA.finish('failed'); await recordUpstreamFault(env, 'a', 0, 1800, 'timeout');
    requestB.finish('failed'); expect(await recordUpstreamFault(env, 'a', 0, 1800, 'timeout')).toBeNull();
    now += 30_000;
    const shared = await b.get();
    expect(() => healthB.select(shared, ['a'], 1_800_000, 30_000)).toThrow(expect.objectContaining({status: 503}));
    await clearUpstreamFault(env, 'a'); now += 30_000;
    const refreshed = await b.get();
    expect(healthB.select(refreshed, ['a'], 1_800_000, 30_000).upstream.id).toBe('a');
    expect(() => healthB.select(shared, ['a'], 1_800_000, 30_000)).toThrow();
    expect(healthB.select(refreshed, ['a'], 1_800_000, 30_000).upstream.id).toBe('a');
  });
});
