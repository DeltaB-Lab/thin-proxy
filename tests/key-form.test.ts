// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('creates and edits a single upstream binding or the default through the management form', async () => {
  const html = await readFile('web/index.html', 'utf8');
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1];
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
  let key: Record<string, unknown> | undefined;
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/_relay/api/snapshot') return Response.json({
      config: { proxyUrl: 'https://relay.example', activeUpstreamId: 'a', cacheTtlSeconds: 30 },
      upstreams: ['a', 'b'].map(id => ({ id, name: `Upstream ${id}`, baseUrl: `https://${id}.example`, authType: 'bearer' })),
      keys: key ? [key] : []
    });
    key = { id: 'key-id', name: '', keyPrefix: 'sk-test', createdAt: '2026-11-06', enabled: true,
      ...key, ...JSON.parse(init!.body as string) };
    return Response.json({ ...key, key: 'test-only-key' });
  });
  vi.stubGlobal('fetch', fetchMock);
  await import('../web/app');
  await vi.waitFor(() => expect(document.getElementById('dashboard')!.hidden).toBe(false));
  document.getElementById('add-key')!.click();
  const form = document.getElementById('key-form') as HTMLFormElement;
  const select = form.elements.namedItem('upstreamId') as HTMLSelectElement;
  expect(Array.from(select.options).map(o => o.value)).toEqual(['', 'a', 'b']);
  expect(select.value).toBe('');
  (form.elements.namedItem('name') as HTMLInputElement).value = 'Laptop';
  select.value = 'b';
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.getElementById('add-key')!.hasAttribute('disabled')).toBe(false));
  expect(document.getElementById('key-list')!.textContent).toContain('指定上游：Upstream b');
  (document.getElementById('created-dialog') as HTMLDialogElement).close();
  Array.from(document.querySelectorAll<HTMLButtonElement>('#key-list button')).find(b => b.textContent === '编辑')!.click();
  expect(select.value).toBe('b'); select.value = '';
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.getElementById('key-list')!.textContent).toContain('跟随默认上游：Upstream a'));
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'GET').map(([path, init]) => ({
    path, method: init!.method, body: JSON.parse(init!.body as string)
  }))).toEqual([
    { path: '/_relay/api/keys', method: 'POST', body: { name: 'Laptop', upstreamId: 'b' } },
    { path: '/_relay/api/keys/key-id', method: 'PATCH', body: { name: 'Laptop', upstreamId: null } }
  ]);
});
