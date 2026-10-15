import type { EncryptedKey, Env, Upstream } from './types';
const encoder = new TextEncoder();
export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
export function urlEncode(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function urlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return unbase64(value.replace(/-/g, '+').replace(/_/g, '/'));
}
export function randomToken(): string {
  return urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
export function randomAccessKey(): string {
  // 61 full base64url characters retain 366 random bits; 3 + 61 = 64 characters.
  return `sk-${urlEncode(crypto.getRandomValues(new Uint8Array(46))).slice(0, 61)}`;
}
export async function hash(value: string): Promise<string> {
  return urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([hash(a), hash(b)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  const raw = unbase64(env.UPSTREAM_KEY_ENCRYPTION_KEY);
  if (raw.length !== 32) throw new Error('Invalid encryption configuration');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encryptValue(env: Env, purpose: string, id: string, value: string): Promise<EncryptedKey> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode(`worker-relay/${purpose}/v1:${id}`)
  }, await encryptionKey(env), encoder.encode(value));
  return { keyIv: base64(iv), keyCiphertext: base64(new Uint8Array(ciphertext)), keyVersion: 1 };
}
async function decryptValue(env: Env, purpose: string, id: string, encrypted: EncryptedKey): Promise<string> {
  if (encrypted.keyVersion !== 1) throw new Error('Unsupported key version');
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: unbase64(encrypted.keyIv),
    additionalData: encoder.encode(`worker-relay/${purpose}/v1:${id}`)
  }, await encryptionKey(env), unbase64(encrypted.keyCiphertext));
  return new TextDecoder().decode(plaintext);
}
export const encryptKey = (env: Env, id: string, value: string) => encryptValue(env, 'upstream', id, value);
export const decryptKey = (env: Env, upstream: Upstream) => decryptValue(env, 'upstream', upstream.id, upstream);
export const encryptAccessKey = (env: Env, id: string, value: string) => encryptValue(env, 'access-key', id, value);
export const decryptAccessKey = (env: Env, id: string, encrypted: EncryptedKey) => decryptValue(env, 'access-key', id, encrypted);
export async function signingKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error('Invalid admin configuration');
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('worker-relay'),
    info: encoder.encode('worker-relay/admin-session/v1')
  }, material, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}
