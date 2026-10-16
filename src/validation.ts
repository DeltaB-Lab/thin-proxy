import { HttpError } from './errors';
import type { Env, AuthType } from './types';
export function invalid(message: string): never { throw new HttpError(400, 'INVALID_INPUT', message); }
export function field(value: unknown, name: string, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${name}不能为空，且长度不能超过 ${max}`);
  return value.trim();
}
export function upstreamKey(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[^\x21-\x7e]/.test(value)) invalid('上游 Key 必须是可用于请求头的非空字符');
  return value;
}
export function authType(value: unknown): AuthType {
  if (value !== 'bearer' && value !== 'x-api-key') invalid('不支持的鉴权方式');
  return value;
}
export function isSelf(hostname: string, request: Request, env: Env): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/\.$/, '');
  const self = [new URL(request.url).hostname, ...(env.SELF_HOSTS ?? '').split(',')].map(s => normalize(s.trim()));
  return self.includes(normalize(hostname));
}
export function baseUrl(value: unknown, request: Request, env: Env): string {
  return upstreamUrl(value, request, env, false);
}
export function modelCatalogUrl(value: unknown, request: Request, env: Env): string | undefined {
  if (value == null || (typeof value === 'string' && !value.trim())) return undefined;
  return upstreamUrl(value, request, env, true);
}
function upstreamUrl(value: unknown, request: Request, env: Env, catalog: boolean): string {
  const name = catalog ? '模型目录 URL' : '上游 URL';
  const raw = field(value, name, 2048);
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(`${name} 格式错误`); }
  if (url.protocol !== 'https:' || url.username || url.password || (!catalog && raw.includes('?')) || raw.includes('#')) {
    invalid(catalog ? '模型目录仅支持 HTTPS，不允许用户名、密码或 fragment' : '上游仅支持 HTTPS，不允许用户名、密码、查询参数或 fragment');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // Conservative literal/local address policy. DNS destinations are configured by the sole administrator.
  if (host.startsWith('[') || !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    invalid('请使用公开上游域名或公开 IPv4 地址');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19))) invalid('不允许本机、私有或保留地址');
  }
  if (isSelf(host, request, env)) invalid('上游不能指向代理自身');
  return url.href;
}
export async function managementBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) invalid('管理接口需要 JSON');
  // Only management requests are parsed. Proxy body streams never enter this function.
  const reader = request.body?.getReader();
  if (!reader) invalid('缺少请求体');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32_768) { await reader.cancel(); throw new HttpError(413, 'BODY_TOO_LARGE', '管理请求过大'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { return invalid('管理请求 JSON 无效'); }
}
