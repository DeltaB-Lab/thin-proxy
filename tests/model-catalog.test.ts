import { describe, expect, it } from 'vitest';
import { upstreamTargetUrl } from '../src/proxy';
import { modelCatalogUrl } from '../src/validation';
import type { Env } from '../src/types';

const path = '/backend-api/codex/models';
const incoming = (suffix = '') => new URL(`https://relay.example${path}${suffix}`);

describe('model catalog destinations', () => {
  it.each(['', '/v1', '/gateway/v1/'])('appends the catalog path to the selected upstream prefix %s when unset', prefix => {
    expect(upstreamTargetUrl({ baseUrl: `https://up.example${prefix}` }, incoming('?x=1&x=2&q=a%20b')).href)
      .toBe(`https://up.example${prefix.replace(/\/$/, '')}${path}?x=1&x=2&q=a%20b`);
  });
  it('uses the full override with configured query names taking precedence and raw values preserved', () => {
    const upstream = { baseUrl: 'https://chat.example/v1', modelCatalogUrl: 'https://catalog.example/custom%2Flist.json?client_version=fixed&tag=a&tag=b&q=a%20b' };
    expect(upstreamTargetUrl(upstream, incoming('?client_version=old&client%5Fversion=new&tag=c&x=1&x=2&q=other&raw=%2f+%20')).href)
      .toBe('https://catalog.example/custom%2Flist.json?client_version=fixed&tag=a&tag=b&q=a%20b&x=1&x=2&raw=%2f+%20');
    expect(upstreamTargetUrl(upstream, incoming()).href).toBe(upstream.modelCatalogUrl);
  });
  it('preserves incoming query encoding when the override has no query', () => {
    expect(upstreamTargetUrl({ baseUrl: 'https://chat.example', modelCatalogUrl: 'https://catalog.example/list' }, incoming('?q=a%20b&x=1&x=2')).href)
      .toBe('https://catalog.example/list?q=a%20b&x=1&x=2');
  });
  it.each(['/v1/models', '/v1/responses', `${path}/`, `${path}/extra`, '/backend-api/codex/%6Dodels'])('keeps ordinary forwarding for %s', requestPath => {
    expect(upstreamTargetUrl({ baseUrl: 'https://chat.example/v1', modelCatalogUrl: 'https://catalog.example/list' }, new URL(`https://relay.example${requestPath}?x=1`)).href)
      .toBe(`https://chat.example/v1${requestPath.startsWith('/v1/') ? requestPath.slice(3) : requestPath}?x=1`);
  });
  it('normalizes optional values and enforces self-host restrictions while allowing query parameters', () => {
    const env = { SELF_HOSTS: 'other-relay.example' } as Env;
    const request = new Request('https://relay.example/_relay/api/upstreams');
    for (const value of [undefined, null, '', '  ']) expect(modelCatalogUrl(value, request, env)).toBeUndefined();
    expect(modelCatalogUrl(' https://catalog.example/list?x=1 ', request, env)).toBe('https://catalog.example/list?x=1');
    expect(() => modelCatalogUrl('https://other-relay.example/list', request, env)).toThrow();
  });
});
