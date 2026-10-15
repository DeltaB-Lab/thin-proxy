import { HttpError } from './errors';
import type { Env, Snapshot, Upstream } from './types';

type Outcome = 'healthy' | 'failed' | 'cancelled';
interface Health {
  signature: string;
  retryAt: number;
  failures: number;
  probe?: { token: symbol; expectedEnd: number };
}
export interface UpstreamAttempt {
  upstream: Upstream;
  finish(outcome: Outcome): void;
}

export function upstreamCooldownSeconds(env: Env): number {
  const seconds = Number(env.UPSTREAM_COOLDOWN_SECONDS ?? '180');
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) throw new Error('Invalid upstream cooldown');
  return seconds;
}

function signature(upstream: Upstream): string {
  return JSON.stringify([upstream.baseUrl, upstream.authType, upstream.keyVersion, upstream.keyIv, upstream.keyCiphertext]);
}

// One instance per D1 binding in this isolate. No persistent state or background probes.
export class UpstreamHealth {
  private version = -1;
  private records = new Map<string, Health>();
  constructor(private readonly now = Date.now) {}

  select(snapshot: Snapshot, ids: string[], cooldownMs: number, timeoutMs: number): UpstreamAttempt {
    if (snapshot.version > this.version) {
      const next = new Map<string, Health>();
      for (const upstream of snapshot.config.upstreams) {
        const fingerprint = signature(upstream);
        const previous = this.records.get(upstream.id);
        next.set(upstream.id, previous?.signature === fingerprint ? previous : { signature: fingerprint, retryAt: 0, failures: 0 });
      }
      this.records = next;
      this.version = snapshot.version;
    }
    const now = this.now();
    let nextRetry = Infinity;
    for (const id of ids) {
      const upstream = snapshot.config.upstreams.find(item => item.id === id);
      if (!upstream) throw new HttpError(503, 'CONFIG_UNAVAILABLE', 'Key 指定的上游不存在');
      const fingerprint = signature(upstream);
      const current = this.records.get(id);
      // An older in-flight snapshot may still run, but cannot overwrite newer health/configuration.
      const health = current?.signature === fingerprint ? current : { signature: fingerprint, retryAt: 0, failures: 0 };
      if (health.retryAt > now || health.probe) {
        nextRetry = Math.min(nextRetry, Math.max(health.retryAt, health.probe?.expectedEnd ?? 0));
        continue;
      }
      const token = health.retryAt ? Symbol('probe') : undefined;
      if (token) health.probe = { token, expectedEnd: now + timeoutMs };
      const failures = health.failures;
      let finished = false;
      return { upstream, finish: outcome => {
        if (finished) return;
        finished = true;
        if (this.records.get(id) !== health) return;
        if (outcome === 'failed') {
          health.retryAt = this.now() + cooldownMs;
          health.failures++;
        } else if (outcome === 'healthy' && token && health.failures === failures) {
          // A late success must not clear a failure from another request.
          health.retryAt = 0;
        }
        if (token && health.probe?.token === token) health.probe = undefined;
      } };
    }
    const seconds = Math.max(1, Math.ceil((nextRetry - now) / 1000));
    throw new HttpError(503, 'UPSTREAMS_COOLING_DOWN', '所选上游正在冷却或探测，请稍后重试', { 'Retry-After': String(seconds) });
  }
}

const instances = new WeakMap<D1Database, UpstreamHealth>();
export function getUpstreamHealth(env: Env): UpstreamHealth {
  let health = instances.get(env.DB);
  if (!health) { health = new UpstreamHealth(); instances.set(env.DB, health); }
  return health;
}
