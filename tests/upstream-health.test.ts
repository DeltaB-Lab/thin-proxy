import { beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../src/storage';
import { UpstreamHealth, upstreamCooldownSeconds } from '../src/upstream-health';
import type { Env, Snapshot, Upstream } from '../src/types';

let now: number;
let health: UpstreamHealth;
let state: Snapshot;
const upstreams = ['a','b'].map(id => ({id,name:id,baseUrl:`https://${id}.example`,authType:'bearer',keyVersion:1,keyIv:'iv',keyCiphertext:'cipher'} as Upstream));
const select = (ids = ['a','b'], input = state) => health.select(input, ids, 180_000, 30_000);
beforeEach(() => {
  now = 1_000; health = new UpstreamHealth(() => now);
  state = snapshot(1, {activeUpstreamId:'a',upstreams:structuredClone(upstreams),accessKeys:[]});
});
describe('cooldown state machine', () => {
  it('does not extend a local deadline for a second failure from the same generation', () => {
    const a = select(['a']); const b = select(['a']);
    expect(a.finish('failed')).toBe(true);
    now += 30_000;
    expect(b.finish('failed')).toBe(false);
    expect(() => select(['a'])).toThrow(expect.objectContaining({headers:{'Retry-After':'150'}}));
  });
  it('reconciles persisted revisions and fences in-flight results after a manual clear', () => {
    const old = select(['a']);
    const clear = structuredClone(state); clear.version++;
    clear.config.upstreams[0].healthRevision = 1;
    health.sync(clear);
    expect(old.finish('failed')).toBe(false);
    const fresh = select(['a'], clear); expect(fresh.finish('failed')).toBe(true);
    const clearedAgain = structuredClone(clear); clearedAgain.version++;
    clearedAgain.config.upstreams[0].healthRevision = 2;
    health.sync(clearedAgain);
    expect(select(['a'], clearedAgain).upstream.id).toBe('a');
  });
  it('defaults to thirty minutes and validates configurable seconds', () => {
    expect(upstreamCooldownSeconds({} as Env)).toBe(1800);
    for (const value of ['1','300','86400']) expect(upstreamCooldownSeconds({UPSTREAM_COOLDOWN_SECONDS:value} as Env)).toBe(Number(value));
    for (const value of ['0','-1','1.5','NaN','Infinity','','86401']) expect(() => upstreamCooldownSeconds({UPSTREAM_COOLDOWN_SECONDS:value} as Env)).toThrow();
  });
  it('reserves one expired probe, restores priority on success, and recools on failure', () => {
    select().finish('failed'); expect(select().upstream.id).toBe('b');
    now += 180_000;
    const probe = select(); expect(probe.upstream.id).toBe('a');
    expect(select().upstream.id).toBe('b'); probe.finish('healthy');
    const first = select(); expect(first.upstream.id).toBe('a'); first.finish('failed');
    now += 180_000; select().finish('failed');
    expect(select().upstream.id).toBe('b');
  });
  it('returns the earliest finite Retry-After when all candidates cool or are being probed', () => {
    select(['a']).finish('failed'); now += 15_500; select(['b']).finish('failed');
    expect(() => select()).toThrow(expect.objectContaining({status:503,headers:{'Retry-After':'165'}}));
    now = 181_000; const a = select(['a']);
    expect(() => select()).toThrow(expect.objectContaining({headers:{'Retry-After':'16'}}));
    now += 16_000; const b = select(['b']);
    expect(() => select()).toThrow(expect.objectContaining({headers:{'Retry-After':'14'}}));
    now += 60_000;
    expect(() => select()).toThrow(expect.objectContaining({headers:{'Retry-After':'1'}}));
    a.finish('cancelled'); b.finish('cancelled'); expect(select().upstream.id).toBe('a');
  });
  it('releases cancelled probes without adding another cooldown', () => {
    select().finish('failed'); now += 180_000;
    const probe = select(); probe.finish('cancelled');
    expect(select().upstream.id).toBe('a');
  });
  it('retains cooldown across renames and route changes but resets changed destination, auth or credentials', () => {
    for (const field of ['baseUrl','authType','keyIv','keyCiphertext','keyVersion'] as const) {
      health = new UpstreamHealth(() => now);
      const old = structuredClone(state); select(['a'],old).finish('failed');
      const renamed = structuredClone(old); renamed.version++; renamed.config.upstreams[0].name = 'renamed';
      expect(select(['b','a'],renamed).upstream.id).toBe('b');
      expect(() => select(['a'],renamed)).toThrow(expect.objectContaining({status:503}));
      const changed = structuredClone(renamed); changed.version++;
      Object.assign(changed.config.upstreams[0], {[field]:field === 'keyVersion' ? 2 : 'changed'});
      expect(select(['a'],changed).upstream.id).toBe('a');
    }
  });
  it('ignores stale attempts and snapshots after an upstream is replaced or removed', () => {
    const pending = select(['a']);
    const old = structuredClone(state);
    state.version++; state.config.upstreams[0].baseUrl = 'https://new.example';
    select(['a']).finish('healthy'); pending.finish('failed');
    select(['a'],old).finish('failed'); expect(select(['a']).upstream.baseUrl).toBe('https://new.example');
    state.version++; state.config.upstreams = state.config.upstreams.slice(1); select(['b']);
    expect(() => select(['a'])).toThrow(expect.objectContaining({code:'CONFIG_UNAVAILABLE'}));
    state.version++; state.config.upstreams.unshift(structuredClone(upstreams[0]));
    expect(select(['a']).upstream.id).toBe('a');
  });
  it('does not let late successes clear failures from other concurrent requests', () => {
    const lateSuccess = select(['a']); const lateFailure = select(['a']);
    select(['a']).finish('failed'); lateSuccess.finish('healthy');
    expect(() => select(['a'])).toThrow(expect.objectContaining({status:503}));
    now += 180_000; const probe = select(['a']);
    expect(lateFailure.finish('failed')).toBe(false);
    probe.finish('failed');
    expect(() => select(['a'])).toThrow(expect.objectContaining({status:503}));
    now += 180_000; select(['a']).finish('healthy'); expect(select(['a']).upstream.id).toBe('a');
  });
  it('settles attempts once so cleanup cannot replace an actual outcome', () => {
    const attempt = select(['a']); attempt.finish('failed'); attempt.finish('healthy'); attempt.finish('cancelled');
    expect(() => select(['a'])).toThrow(expect.objectContaining({status:503}));
  });
});
