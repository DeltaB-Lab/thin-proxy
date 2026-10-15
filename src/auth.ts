import { HttpError } from './errors';
import { randomToken, signingKey, urlDecode, urlEncode } from './crypto';
export const COOKIE_NAME = 'relay_admin';
const PURPOSE = 'worker-relay/admin-session/v1';
const MAX_AGE = 3600;
const encoder = new TextEncoder();
export async function issueSession(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = urlEncode(encoder.encode(JSON.stringify({ purpose: PURPOSE, iat: now, exp: now + MAX_AGE, nonce: randomToken() })));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload));
  return `${payload}.${urlEncode(new Uint8Array(signature))}`;
}
export function sessionCookie(value: string, clear = false): string {
  return `${COOKIE_NAME}=${value}; Path=/_relay/; Max-Age=${clear ? 0 : MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
}
export async function requireSession(request: Request, secret: string): Promise<void> {
  try {
    const cookies = (request.headers.get('Cookie') ?? '').split(';').map(v => v.trim());
    const matches = cookies.filter(v => v.startsWith(`${COOKIE_NAME}=`));
    if (matches.length !== 1) throw new Error();
    const token = matches[0].slice(COOKIE_NAME.length + 1);
    if (token.length > 2048) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error();
    const [payload, signature] = parts;
    const valid = await crypto.subtle.verify('HMAC', await signingKey(secret), urlDecode(signature), encoder.encode(payload));
    if (!valid) throw new Error();
    const data = JSON.parse(new TextDecoder().decode(urlDecode(payload)));
    const now = Math.floor(Date.now() / 1000);
    if (data.purpose !== PURPOSE || !Number.isInteger(data.iat) || !Number.isInteger(data.exp) ||
      data.iat > now || data.exp <= now || data.exp <= data.iat || data.exp - data.iat > MAX_AGE ||
      typeof data.nonce !== 'string') throw new Error();
  } catch {
    throw new HttpError(401, 'INVALID_SESSION', '请使用管理密钥登录');
  }
}
export function requireOrigin(request: Request): void {
  if (request.headers.get('Origin') !== new URL(request.url).origin) {
    throw new HttpError(403, 'INVALID_ORIGIN', '管理操作只允许同源请求');
  }
}
export function forwardingToken(request: Request): string {
  const authorization = request.headers.get('Authorization');
  const apiKey = request.headers.get('x-api-key');
  let bearer: string | undefined;
  if (authorization !== null) {
    const match = /^Bearer ([^\s,]+)$/i.exec(authorization);
    if (!match) throw new HttpError(401, 'INVALID_KEY', '转发 Key 无效');
    bearer = match[1];
  }
  if (bearer && apiKey !== null && bearer !== apiKey) {
    throw new HttpError(400, 'CONFLICTING_KEYS', '两个鉴权头中的 Key 不一致');
  }
  const token = bearer ?? apiKey;
  if (!token || token.length > 256 || !/^relay_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new HttpError(401, 'INVALID_KEY', '缺少或无效的转发 Key');
  }
  return token;
}
