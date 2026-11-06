import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';

const secret = 'login-test-secret-with-at-least-32-characters';
const origin = 'https://relay.example';
function setup() {
  const counts = new Map<string, number>();
  const limit = vi.fn(async ({ key }: { key: string }) => {
    const attempts = (counts.get(key) ?? 0) + 1; counts.set(key, attempts);
    return { success: attempts <= 5 };
  });
  const prepare = vi.fn(() => { throw new Error('Login must not use D1'); });
  const env = { ADMIN_KEY: secret, ADMIN_LOGIN_LIMITER: { limit }, DB: { prepare } } as unknown as Env;
  const call = (key: string, headers: Record<string, string> = {}) => worker.fetch(new Request(origin + '/_relay/api/session', {
    method: 'POST', headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ key })
  }), env);
  return { call, env, limit, prepare };
}

describe('management login protection', () => {
  it('limits repeated attempts without D1, keeps clients separate, and does not trust XFF', async () => {
    const { call, limit, prepare } = setup();
    for (let i = 0; i < 5; i++) expect((await call('wrong', { 'X-Forwarded-For': `192.0.2.${i + 10}` })).status).toBe(401);
    const blocked = await call(secret);
    expect(blocked.status).toBe(429); expect(blocked.headers.get('Retry-After')).toBe('60');
    expect((await call(secret, { 'CF-Connecting-IP': '192.0.2.2' })).status).toBe(200);
    const keys = limit.mock.calls.map(([options]) => options.key);
    expect(new Set(keys.slice(0, 6)).size).toBe(1); expect(keys[6]).not.toBe(keys[0]);
    expect(keys.join('')).not.toContain(secret); expect(keys.join('')).not.toContain('192.0.2.');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('isolates deployments sharing a rate-limit namespace and checks origin before counting', async () => {
    const { call, env, limit, prepare } = setup();
    expect((await call('wrong', { Origin: 'https://other.example' })).status).toBe(403);
    expect(limit).not.toHaveBeenCalled();
    await call('wrong'); env.ADMIN_KEY = secret + '-another-deployment'; await call('wrong');
    expect(limit.mock.calls[0][0].key).not.toBe(limit.mock.calls[1][0].key);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    'replace-with-a-random-secret-at-least-32-characters', 'changeme-'.repeat(8),
    'a'.repeat(64), 'short', ` ${secret}`
  ])('rejects unsafe configured administrator secrets without issuing a cookie: %s', async unsafe => {
    const { call, env, limit, prepare } = setup(); env.ADMIN_KEY = unsafe;
    const response = await call(unsafe);
    expect(response.status).toBe(500); expect(response.headers.has('Set-Cookie')).toBe(false);
    expect(await response.text()).not.toContain(unsafe);
    expect(limit).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });

  it('fails closed when the limiter is unavailable and does not expose its exception', async () => {
    const { call, limit, prepare } = setup();
    limit.mockRejectedValueOnce(new Error('private binding credentials'));
    const response = await call(secret);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('private');
    expect(response.headers.has('Set-Cookie')).toBe(false); expect(prepare).not.toHaveBeenCalled();
  });
});
