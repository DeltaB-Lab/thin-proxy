import type { AuthType } from './types';

type Probe = { status: number | null; modelList: boolean };
export type AuthProbeResult = { authType: AuthType; status: number | null; outcome: 'available' | 'rejected' | 'unknown'; message: string };
async function probe(url: string, headers: HeadersInit): Promise<Probe> {
  try {
    const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000), cf: { cacheTtl: -1, cacheEverything: false } });
    const result: Probe = { status: response.status, modelList: false };
    const reader = response.body?.getReader();
    if (!reader) return result;
    try {
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return result;
      let size = 0; let text = ''; const decoder = new TextDecoder();
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > 262_144) return result;
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      try { const data = JSON.parse(text); result.modelList = Array.isArray(data?.data) && data.data.every((m: unknown) => m !== null && typeof m === 'object' && 'id' in m && typeof m.id === 'string'); } catch {}
      return result;
    } finally { await reader.cancel().catch(() => {}); }
  } catch { return { status: null, modelList: false }; }
}
export async function testUpstreamAuth(base: string, key: string) {
  const endpoint = base.replace(/\/+$/, '') + '/models';
  const [anonymous, bearer, apiKey] = await Promise.all([
    probe(endpoint, { Accept: 'application/json' }),
    probe(endpoint, { Accept: 'application/json', Authorization: 'Bearer ' + key }),
    probe(endpoint, { Accept: 'application/json', 'x-api-key': key })
  ]);
  const results: AuthProbeResult[] = ([['bearer', bearer], ['x-api-key', apiKey]] as const).map(([authType, result]) => {
    if (result.modelList && (anonymous.status === 401 || anonymous.status === 403)) return { authType, status: result.status, outcome: 'available', message: '模型列表鉴权通过' };
    if (result.status === 401 || result.status === 403) return { authType, status: result.status, outcome: 'rejected', message: '请求被拒绝，请检查密钥、权限或鉴权方式' };
    return { authType, status: result.status, outcome: 'unknown', message: result.status === null ? '连接失败或超时' : result.modelList ? '无密钥对照未确认鉴权，无法判断' : '接口未返回模型列表，无法判断' };
  });
  return { endpoint, anonymousStatus: anonymous.status, results };
}
