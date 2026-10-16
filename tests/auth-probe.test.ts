import { afterEach, describe, expect, it, vi } from 'vitest';
import { testUpstreamAuth } from '../src/auth-probe';
afterEach(() => vi.unstubAllGlobals());
const models = () => Response.json({data:[{id:'model'}]});
describe('upstream auth detection', () => {
  it('detects both supported headers independently with an anonymous control', async () => {
    const mock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.has('Cookie')).toBe(false);
      expect(init.redirect).toBe('manual');
      if (headers.has('Authorization')) { expect(headers.get('Authorization')).toBe('Bearer test-secret'); expect(headers.has('x-api-key')).toBe(false); return models(); }
      if (headers.has('x-api-key')) { expect(headers.get('x-api-key')).toBe('test-secret'); return models(); }
      return new Response(null,{status:401});
    });
    vi.stubGlobal('fetch',mock);
    const result = await testUpstreamAuth('https://up.example/v1/','test-secret');
    expect(result.endpoint).toBe('https://up.example/v1/models');
    expect(mock).toHaveBeenCalledTimes(3);
    expect(result.results.map(r=>r.outcome)).toEqual(['available','available']);
    expect(result.results.map(r=>r.models)).toEqual([['model'],['model']]);
  });
  it('does not declare public model lists authenticated', async () => {
    vi.stubGlobal('fetch',vi.fn(async()=>models()));
    const result = await testUpstreamAuth('https://up.example','secret');
    expect(result.results.every(r=>r.outcome==='unknown')).toBe(true);
    expect(result.results.map(r=>r.models)).toEqual([['model'],['model']]);
  });
  it('returns only model IDs per auth method, deduplicating without exposing upstream metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'model-b', metadata: 'private' }, { id: 'model-a' }, { id: 'model-b' }] }))
      .mockResolvedValueOnce(Response.json({ data: [] })));
    const result = await testUpstreamAuth('https://up.example', 'secret');
    expect(result.results.map(r => r.models)).toEqual([['model-b', 'model-a'], []]);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('omits model lists for invalid payloads and rejected responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'valid' }, { id: 42 }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'not-authorized' }] }, { status: 403 })));
    const result = await testUpstreamAuth('https://up.example', 'secret');
    expect(result.results.map(r => r.models)).toEqual([undefined, undefined]);
    expect(result.results.map(r => r.outcome)).toEqual(['unknown', 'rejected']);
  });
  it.each([302,404,429,500])('does not treat HTTP %i as an unsupported auth method', async status => {
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status})));
    expect((await testUpstreamAuth('https://up.example','secret')).results.every(r=>r.outcome==='unknown')).toBe(true);
  });
  it('does not treat a successful HTML login page as authenticated', async () => {
    const mock=vi.fn().mockResolvedValueOnce(new Response(null,{status:401})).mockImplementation(async()=>new Response('<html>Login</html>',{headers:{'Content-Type':'text/html'}}));
    vi.stubGlobal('fetch',mock);
    expect((await testUpstreamAuth('https://up.example','secret')).results.every(r=>r.outcome==='unknown')).toBe(true);
  });
  it('returns safe results for network failure and bounds response size', async () => {
    vi.stubGlobal('fetch',vi.fn().mockRejectedValueOnce(new Error('test-secret')).mockResolvedValueOnce(new Response(null,{status:401})).mockResolvedValueOnce(new Response('x'.repeat(262145),{headers:{'Content-Type':'application/json'}})));
    const result=await testUpstreamAuth('https://up.example','test-secret');
    expect(result.results.map(r=>r.outcome)).toEqual(['rejected','unknown']);
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });
});
