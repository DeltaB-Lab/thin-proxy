import { describe, expect, it } from 'vitest';
import { forwardingToken, issueSession, requireSession, requireOrigin } from '../src/auth';
import { targetUrl } from '../src/proxy';
import { encryptAccessKey, decryptAccessKey, encryptKey, decryptKey } from '../src/crypto';
import { baseUrl } from '../src/validation';
import type { Env, Upstream } from '../src/types';
const secret = 'test-admin-only-not-for-production-123456789';
const key = `relay_${'a'.repeat(43)}`;
const env = { ADMIN_KEY: secret, UPSTREAM_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'), SELF_HOSTS: 'other-relay.example' } as Env;
describe('credential and URL boundaries', () => {
  it('requires signed unexpired management credentials and rejects tampering/rotation', async () => {
    const token = await issueSession(secret);
    const request = (value: string) => new Request('https://relay.example/_relay/api/config', { headers: { Cookie: `relay_admin=${value}` } });
    await expect(requireSession(request(token), secret)).resolves.toBeUndefined();
    await expect(requireSession(request(`${token}x`), secret)).rejects.toThrow();
    await expect(requireSession(request(token), `${secret}-rotated`)).rejects.toThrow();
    await expect(requireSession(request(key), secret)).rejects.toThrow();
  });
  it('rejects mixed identity headers, management keys and cross-origin mutations', () => {
    expect(forwardingToken(new Request('https://relay.example', { headers: { Authorization: `Bearer ${key}`, 'x-api-key': key } }))).toBe(key);
    expect(() => forwardingToken(new Request('https://relay.example', { headers: { Authorization: `Bearer ${key}`, 'x-api-key': 'different' } }))).toThrow();
    expect(() => forwardingToken(new Request('https://relay.example', { headers: { Authorization: `Bearer ${secret}` } }))).toThrow();
    expect(() => requireOrigin(new Request('https://relay.example/_relay/api/keys', { headers: { Origin: 'https://evil.example' } }))).toThrow();
  });
  it.each([
    ['', '/v1/messages', '/v1/messages'],
    ['/v1', '/messages', '/v1/messages'],
    ['/v1', '/v1/messages', '/v1/messages'],
    ['/gateway/v1///', '/v1/messages', '/gateway/v1/messages'],
    ['/v1', '/v1', '/v1'],
    ['/v1', '/v1/', '/v1/'],
    ['/v1', '/v10/messages', '/v1/v10/messages'],
    ['/v1', '/v1beta/messages', '/v1/v1beta/messages'],
    ['/v10', '/v1/messages', '/v10/v1/messages'],
    ['/gateway/v1/api', '/v1/messages', '/gateway/v1/api/v1/messages'],
    ['/v1', '/models/v1/detail', '/v1/models/v1/detail'],
    ['/v1', '/%76%31/messages', '/v1/%76%31/messages'],
    ['/%76%31', '/v1/messages', '/%76%31/v1/messages'],
    ['/v1', '/v1%2Fmessages', '/v1/v1%2Fmessages']
  ])('joins %s and %s with only a boundary v1 overlap removed', (prefix, path, expected) => {
    expect(targetUrl(`https://up.example${prefix}`, new URL(`https://relay.example${path}`)).pathname).toBe(expected);
  });
  it('preserves encoded paths and duplicate query strings when removing a boundary v1 overlap', () => {
    const incoming = new URL('https://relay.example/v1/a%2Fb?x=1&x=2&q=a%20b');
    expect(targetUrl('https://up.example/v1/', incoming).href).toBe('https://up.example/v1/a%2Fb?x=1&x=2&q=a%20b');
    expect(targetUrl('https://up.example', new URL('https://relay.example//evil.example/path')).hostname).toBe('up.example');
  });
  it('rejects unsafe or self-referencing saved targets', () => {
    const request = new Request('https://relay.example/_relay/api/upstreams');
    for (const value of ['http://up.example', 'https://user:pass@up.example', 'https://up.example?x=1', 'https://127.1', 'https://[::1]', 'https://relay.example', 'https://other-relay.example', 'https://10.0.0.1']) {
      expect(() => baseUrl(value, request, env)).toThrow();
    }
    expect(baseUrl('https://up.example/gateway', request, env)).toBe('https://up.example/gateway');
  });
  it('encrypts upstream keys with randomized nonces bound to the upstream id', async () => {
    const a = await encryptKey(env, 'a', 'test-upstream-key');
    const b = await encryptKey(env, 'a', 'test-upstream-key');
    expect(a.keyIv).not.toBe(b.keyIv);
    expect(await decryptKey(env, { id: 'a', ...a } as Upstream)).toBe('test-upstream-key');
    await expect(decryptKey(env, { id: 'b', ...a } as Upstream)).rejects.toThrow();
  });
  it('binds recoverable access keys to their id and separates them from upstream ciphertexts', async () => {
    const encrypted = await encryptAccessKey(env, 'a', key);
    expect(await decryptAccessKey(env, 'a', encrypted)).toBe(key);
    await expect(decryptAccessKey(env, 'b', encrypted)).rejects.toThrow();
    await expect(decryptKey(env, { id: 'a', ...encrypted } as Upstream)).rejects.toThrow();
    const upstream = await encryptKey(env, 'a', key);
    await expect(decryptAccessKey(env, 'a', upstream)).rejects.toThrow();
  });
});
