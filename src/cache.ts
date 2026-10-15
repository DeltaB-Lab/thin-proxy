import { readConfig } from './storage';
import type { Env, Snapshot } from './types';

// Each isolate owns its cache. No timers, shared global cache or stale fallback.
export class ConfigCache {
  private current?: { snapshot: Snapshot; expiresAt: number };
  private pending?: Promise<Snapshot>;
  constructor(private readonly read: () => Promise<Snapshot>, private readonly ttlMs: number, private readonly now = Date.now) {}
  publish(value: Snapshot, startedAt = this.now()): Snapshot {
    if (!this.current || value.version > this.current.snapshot.version ||
      (value.version === this.current.snapshot.version && startedAt + this.ttlMs > this.current.expiresAt)) {
      this.current = { snapshot: value, expiresAt: startedAt + this.ttlMs };
    }
    return this.current.snapshot;
  }
  async get(): Promise<Snapshot> {
    if (this.current && this.now() < this.current.expiresAt) return this.current.snapshot;
    if (this.pending) return this.pending;
    const startedAt = this.now();
    this.pending = this.read().then(value => this.publish(value, startedAt));
    try { return await this.pending; }
    finally { this.pending = undefined; }
  }
}
let instanceCache: { db: D1Database; ttl: number; cache: ConfigCache } | undefined;
export function getCache(env: Env): ConfigCache {
  const ttl = Number(env.CONFIG_CACHE_TTL_SECONDS ?? '30');
  if (!Number.isFinite(ttl) || ttl < 0 || ttl > 3600) throw new Error('Invalid cache TTL');
  if (!instanceCache || instanceCache.db !== env.DB || instanceCache.ttl !== ttl) {
    instanceCache = { db: env.DB, ttl, cache: new ConfigCache(() => readConfig(env), ttl * 1000) };
  }
  return instanceCache.cache;
}
