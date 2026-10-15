import { describe, expect, it } from 'vitest';
import { snapshot } from '../src/storage';
import { keyUpstreamIds } from '../src/key-routing';
import type { Config } from '../src/types';

const config = (): Config => ({
  activeUpstreamId: 'a',
  upstreams: [{ id: 'a', name: 'A', baseUrl: 'https://a.example', authType: 'bearer', keyCiphertext: '', keyIv: '', keyVersion: 1 }],
  accessKeys: [{ id: 'legacy', name: 'Legacy', keyHash: 'hash', keyPrefix: 'relay_test', createdAt: '2026-10-15' }]
});

describe('key routing snapshots', () => {
  it('reads legacy keys without a binding and indexes their metadata', () => {
    const state = snapshot(1, config());
    const key = state.keysByHash.get('hash')!;
    expect(key.id).toBe('legacy');
    expect(keyUpstreamIds(key)).toBeNull();
  });
  it('accepts explicit default and bound keys with no default upstream', () => {
    const data = config(); data.activeUpstreamId = null;
    for (const upstreamId of [null, 'a']) {
      data.accessKeys[0].upstreamId = upstreamId;
      expect(snapshot(1, data).keysByHash.get('hash')?.upstreamId).toBe(upstreamId);
      expect(keyUpstreamIds(data.accessKeys[0])).toEqual(upstreamId ? [upstreamId] : null);
    }
  });
  it.each(['missing', '', 42, false, {}, []])('rejects malformed or dangling bindings: %j', upstreamId => {
    const data = config(); data.accessKeys[0].upstreamId = upstreamId as string;
    expect(() => snapshot(1, data)).toThrow('Invalid stored configuration');
  });
  it('preserves list order and lets an explicit null override a legacy binding', () => {
    const data = config();
    data.upstreams.push({ ...data.upstreams[0], id: 'b' });
    data.accessKeys[0].upstreamIds = ['b', 'a'];
    expect(keyUpstreamIds(snapshot(1, data).keysByHash.get('hash')!)).toEqual(['b', 'a']);
    data.accessKeys[0].upstreamId = 'a'; data.accessKeys[0].upstreamIds = null;
    expect(keyUpstreamIds(snapshot(2, data).keysByHash.get('hash')!)).toBeNull();
  });
  it.each([[], ['a', 'a'], ['missing'], ['a', 42], 'a', false, {}])('rejects invalid route lists: %j', upstreamIds => {
    const data = config(); data.accessKeys[0].upstreamIds = upstreamIds as string[];
    expect(() => snapshot(1, data)).toThrow('Invalid stored configuration');
  });
});
