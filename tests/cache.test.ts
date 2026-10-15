import { describe, expect, it, vi } from 'vitest';
import { ConfigCache } from '../src/cache';
import { snapshot } from '../src/storage';
const state = (v: number) => snapshot(v, { activeUpstreamId: null, upstreams: [], accessKeys: [] });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
describe('bounded per-instance config cache', () => {
  it('coalesces cold reads, does not slide TTL, refreshes once expired', async () => {
    let now = 0; const read = vi.fn().mockResolvedValue(state(1));
    const cache = new ConfigCache(read, 30_000, () => now);
    await Promise.all([cache.get(), cache.get(), cache.get()]); expect(read).toHaveBeenCalledTimes(1);
    now = 29_999; await cache.get(); expect(read).toHaveBeenCalledTimes(1);
    now = 30_000; await cache.get(); expect(read).toHaveBeenCalledTimes(2);
  });
  it('never uses an expired snapshot when refresh fails and can recover', async () => {
    let now = 0; const read = vi.fn().mockResolvedValueOnce(state(1)).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(state(2));
    const cache = new ConfigCache(read, 30_000, () => now);
    await cache.get(); now = 30_001;
    await expect(cache.get()).rejects.toThrow('offline');
    expect((await cache.get()).version).toBe(2);
  });
  it('a slow old load cannot overwrite a committed version or return it to waiters', async () => {
    let now = 0; const load = deferred<ReturnType<typeof state>>();
    const read = vi.fn(() => load.promise); const cache = new ConfigCache(read, 30_000, () => now);
    const first = cache.get(); now = 500; cache.publish(state(2)); load.resolve(state(1));
    expect((await first).version).toBe(2); expect((await cache.get()).version).toBe(2);
    cache.publish(state(1), 1000); now = 30_501;
    await cache.get(); expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not give a slow read a fresh TTL from completion', async () => {
    let now = 0; const load = deferred<ReturnType<typeof state>>();
    const read = vi.fn().mockReturnValueOnce(load.promise).mockResolvedValue(state(2));
    const cache = new ConfigCache(read, 30_000, () => now);
    const first = cache.get(); now = 31_000; load.resolve(state(1)); await first;
    expect((await cache.get()).version).toBe(2); expect(read).toHaveBeenCalledTimes(2);
  });
  it('TTL zero disables reuse; separate instances load independently', async () => {
    const read = vi.fn().mockResolvedValue(state(1));
    const a = new ConfigCache(read, 0); const b = new ConfigCache(read, 0);
    await a.get(); await a.get(); await b.get(); expect(read).toHaveBeenCalledTimes(3);
  });
});
