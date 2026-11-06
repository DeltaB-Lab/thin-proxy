// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('submits, reopens and clears the catalog URL in the real management form', async () => {
  const html = await readFile('web/index.html', 'utf8');
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1];
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
  let upstream: Record<string, unknown> | undefined;
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/_relay/api/snapshot') return Response.json({
      config: { proxyUrl: 'https://relay.example', activeUpstreamId: null, cacheTtlSeconds: 30 },
      upstreams: upstream ? [upstream] : [], keys: []
    });
    if (path === '/_relay/api/test-auth') return Response.json({ results: [
      { authType: 'bearer', status: 200, outcome: 'available', message: '模型列表鉴权通过', models: ['model-a', '<img src=x onerror=alert(1)>'] },
      { authType: 'x-api-key', status: 200, outcome: 'unknown', message: '无密钥对照未确认鉴权，无法判断', models: [] }
    ] });
    const body = JSON.parse(init!.body as string);
    upstream = { ...upstream, ...body, id: 'a' };
    return Response.json(upstream);
  });
  vi.stubGlobal('fetch', fetchMock);
  await import('../web/app');
  await vi.waitFor(() => expect(document.getElementById('dashboard')!.hidden).toBe(false));
  document.getElementById('add-upstream')!.click();
  const form = document.getElementById('upstream-form') as HTMLFormElement;
  const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  expect(input('modelCatalogUrl').value).toBe(''); expect(input('modelCatalogUrl').required).toBe(false);
  input('name').value = 'Catalog upstream'; input('baseUrl').value = 'https://chat.example/v1'; input('key').value = 'test-secret';
  input('modelCatalogUrl').value = 'https://catalog.example/list?version=2';
  document.getElementById('test-auth')!.click();
  await vi.waitFor(() => expect(document.querySelectorAll('.auth-models li')).toHaveLength(2));
  expect(Array.from(document.querySelectorAll('.auth-models li')).map(li => li.textContent)).toEqual(['model-a', '<img src=x onerror=alert(1)>']);
  expect(document.querySelector('.auth-models img')).toBeNull();
  expect(document.getElementById('auth-test-results')!.textContent).toContain('模型列表为空');
  await vi.waitFor(() => expect(document.getElementById('test-auth')!.hasAttribute('disabled')).toBe(false));
  const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  submit();
  const dialog = document.getElementById('upstream-dialog') as HTMLDialogElement;
  await vi.waitFor(() => expect(dialog.open).toBe(false));
  await vi.waitFor(() => expect(document.querySelector('#upstream-list h3')?.textContent).toBe('Catalog upstream'));
  const edit = () => Array.from(document.querySelectorAll<HTMLButtonElement>('#upstream-list button')).find(b => b.textContent === '编辑')!.click();
  edit(); expect(input('modelCatalogUrl').value).toBe('https://catalog.example/list?version=2');
  input('modelCatalogUrl').value = ''; submit();
  await vi.waitFor(() => expect(dialog.open).toBe(false));
  await vi.waitFor(() => expect(document.getElementById('add-upstream')!.hasAttribute('disabled')).toBe(false));
  edit(); expect(input('modelCatalogUrl').value).toBe('');
  const saves = fetchMock.mock.calls.filter(([path, init]) => path !== '/_relay/api/test-auth' && (init?.method === 'POST' || init?.method === 'PATCH'));
  expect(saves.map(([path, init]) => ({ path, method: init!.method, catalog: JSON.parse(init!.body as string).modelCatalogUrl }))).toEqual([
    { path: '/_relay/api/upstreams', method: 'POST', catalog: 'https://catalog.example/list?version=2' },
    { path: '/_relay/api/upstreams/a', method: 'PATCH', catalog: '' }
  ]);
});
