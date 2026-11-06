import { describe, expect, it } from 'vitest';
import { snapshot } from '../src/storage';
import type { Config } from '../src/types';

const config = (): Config => ({
  activeUpstreamId: 'a',
  upstreams: ['a', 'b'].map(id => ({ id, name: id, baseUrl: `https://${id}.example`, authType: 'bearer', keyCiphertext: '', keyIv: '', keyVersion: 1 })),
  accessKeys: [{ id: 'legacy', name: 'Legacy', keyHash: 'hash', keyPrefix: 'relay_test', createdAt: '2026-10-15' }]
});

describe('single-upstream configuration snapshots', () => {
  it.each([null, 42, false, {}, []])('rejects malformed persisted catalog URLs: %j', value => {
    const data = config(); data.upstreams[0].modelCatalogUrl = value as unknown as string;
    expect(() => snapshot(1, data)).toThrow('Invalid stored configuration');
  });
  it.each([undefined, null, 'a'])('reads a single binding or the default without changing credentials: %s', upstreamId => {
    const data = config(); data.accessKeys[0].upstreamId = upstreamId;
    const key = snapshot(1, data).keysByHash.get('hash')!;
    expect(key).toEqual({ ...data.accessKeys[0], upstreamId: upstreamId ?? null });
  });
  it.each(['missing', '', 42, false, {}, []])('rejects malformed or dangling bindings: %j', upstreamId => {
    const data = config(); data.accessKeys[0].upstreamId = upstreamId as string;
    expect(() => snapshot(1, data)).toThrow('Invalid stored configuration');
  });
  it('uses the first old ordered binding, strips health state, and leaves the source untouched', () => {
    const data = config();
    Object.assign(data.accessKeys[0], { upstreamIds: ['b', 'a'], failoverEnabled: true });
    Object.assign(data.upstreams[1], { healthRevision: 4, faultUntil: 9999999999999, faultReason: 'HTTP 503' });
    const original = structuredClone(data);
    const state = snapshot(1, data);
    expect(state.keysByHash.get('hash')).toEqual({ ...config().accessKeys[0], upstreamId: 'b' });
    expect(state.config.upstreams).toEqual(config().upstreams);
    expect(data).toEqual(original);
  });
  it('keeps an explicit legacy default instead of reviving an obsolete single binding', () => {
    const data = config(); Object.assign(data.accessKeys[0], { upstreamId: 'a', upstreamIds: null, failoverEnabled: true });
    expect(snapshot(1, data).keysByHash.get('hash')?.upstreamId).toBeNull();
  });
  it.each([[], ['missing'], ['a', 42], 'a', false, {}])('rejects unreadable legacy bindings: %j', upstreamIds => {
    const data = config(); Object.assign(data.accessKeys[0], { upstreamIds });
    expect(() => snapshot(1, data)).toThrow('Invalid stored configuration');
  });
  it.each([null, 'false', 0, [], {}])('rejects malformed persisted service status: %j', enabled => {
    const data = config(); data.accessKeys[0].enabled = enabled as unknown as boolean;
    expect(() => snapshot(1, data)).toThrow('Invalid stored configuration');
  });
});
