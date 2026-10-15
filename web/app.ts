interface Upstream { id: string; name: string; baseUrl: string; authType: string }
interface KeyInfo { id: string; name: string; keyPrefix: string; createdAt: string }
interface Settings { proxyUrl: string; activeUpstreamId: string | null; cacheTtlSeconds: number }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let settings: Settings;
let busy = false;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function notify(message: string, error = false) {
  clearTimeout(noticeTimer);
  const node = $('notice'); node.textContent = message; node.hidden = false; node.classList.toggle('error', error);
  if (!error) noticeTimer = setTimeout(() => { node.hidden = true; }, 5000);
  document.querySelectorAll('.dialog-error').forEach(e => e.remove());
  const dialog = document.querySelector('dialog[open]');
  if (error && dialog) { const p = document.createElement('p'); p.className = 'dialog-error'; p.setAttribute('role', 'alert'); p.textContent = message; dialog.append(p); }
}
function showLogin() {
  document.body.classList.add('auth-mode'); $('sidebar').hidden = true;
  $('dashboard').hidden = true; $('logout').hidden = true; $('login-view').hidden = false;
  document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(d => d.close());
}
function navigate() {
  const view = ['upstreams', 'keys'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home';
  $('page-title').textContent = view === 'home' ? '首页' : view === 'upstreams' ? '上游' : 'API KEYS';
  $('home-panel').hidden = view !== 'home';
  $('upstreams-section').hidden = view === 'keys';
  $('keys-section').hidden = view === 'upstreams';
  $('usage').hidden = view !== 'home';
  document.querySelectorAll<HTMLAnchorElement>('[data-view]').forEach(a => {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/_relay/api${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(result.error?.message ?? '请求失败');
  }
  return result;
}
async function action(work: () => Promise<void>) {
  if (busy) return;
  busy = true;
  document.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
  try { await work(); } catch (e) { notify(e instanceof Error ? e.message : '操作失败', true); }
  finally { busy = false; document.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false); }
}
function node(tag: string, text?: string, className?: string): HTMLElement {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
  if (className) el.className = className; return el;
}
function button(text: string, className: string, handler: () => void) {
  const el = document.createElement('button'); el.type = 'button'; el.textContent = text; el.className = className; el.addEventListener('click', handler); return el;
}
function saved() { notify(settings.cacheTtlSeconds ? `已保存，约 ${settings.cacheTtlSeconds} 秒内生效。` : '已保存。'); }
function editUpstream(upstream?: Upstream) {
  document.querySelectorAll('.dialog-error').forEach(e => e.remove());
  const form = $<HTMLFormElement>('upstream-form'); form.reset();
  $('auth-test-results').hidden = true; $('auth-test-results').replaceChildren();
  const set = (name: string, value: string) => (form.elements.namedItem(name) as HTMLInputElement).value = value;
  set('id', upstream?.id ?? ''); set('name', upstream?.name ?? ''); set('baseUrl', upstream?.baseUrl ?? ''); set('authType', upstream?.authType ?? 'bearer');
  (form.elements.namedItem('key') as HTMLInputElement).required = !upstream;
  $('upstream-title').textContent = upstream ? '编辑上游' : '添加上游'; $('edit-key-hint').hidden = !upstream;
  $<HTMLDialogElement>('upstream-dialog').showModal();
}
async function refresh() {
  const [config, list, keys] = await Promise.all([api<Settings>('/config'), api<Upstream[]>('/upstreams'), api<KeyInfo[]>('/keys')]);
  settings = config;
  $('upstream-count').textContent = String(list.length); $('key-count').textContent = String(keys.length);
  $('proxy-url').textContent = settings.proxyUrl;
  $('current-upstream').textContent = list.find(u => u.id === settings.activeUpstreamId)?.name ?? '未选择';
  $('ttl-note').textContent = String(settings.cacheTtlSeconds);
  const cards = $('upstream-list'); cards.replaceChildren();
  if (!list.length) cards.append(node('div', '暂无上游', 'empty'));
  for (const u of list) {
    const active = u.id === settings.activeUpstreamId;
    const card = node('article', undefined, `upstream-card${active ? ' active' : ''}`);
    const heading = node('div', undefined, 'card-title'); heading.append(node('h3', u.name)); if (active) heading.append(node('span', '当前使用', 'badge'));
    card.append(heading, node('p', u.baseUrl, 'muted'), node('span', u.authType === 'bearer' ? 'Authorization: Bearer' : 'x-api-key', 'tag'));
    const actions = node('div', undefined, 'actions');
    actions.append(button(active ? '取消选择' : '设为当前', active ? 'quiet small' : 'small', () => void action(async () => {
      if (active && !confirm('取消后所有转发请求将无法回源，确定取消？')) return;
      await api('/active-upstream', 'PUT', { id: active ? null : u.id }); await refresh(); saved();
    })), button('编辑', 'quiet small', () => editUpstream(u)), button('删除', 'quiet small danger', () => void action(async () => {
      if (active) { notify('请先切换或取消当前上游，再删除。', true); return; }
      if (!confirm(`删除上游“${u.name}”？`)) return;
      await api(`/upstreams/${u.id}`, 'DELETE'); await refresh(); saved();
    })));
    card.append(actions); cards.append(card);
  }
  const rows = $('key-list'); rows.replaceChildren();
  if (!keys.length) rows.append(node('div', '暂无 Key', 'empty'));
  for (const key of keys) {
    const row = node('div', undefined, 'key-row'); const info = node('div');
    info.append(node('strong', key.name), node('p', `${key.keyPrefix}… · ${new Date(key.createdAt).toLocaleString()}`));
    row.append(info, button('撤销', 'quiet small danger', () => void action(async () => {
      if (!confirm(`撤销“${key.name}”？此操作不可恢复。`)) return;
      await api(`/keys/${key.id}`, 'DELETE'); await refresh(); saved();
    }))); rows.append(row);
  }
  document.body.classList.remove('auth-mode'); $('sidebar').hidden = false;
  $('login-view').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false;
  navigate();
}
$<HTMLFormElement>('login-form').addEventListener('submit', e => { e.preventDefault(); void action(async () => {
  const input = $<HTMLInputElement>('admin-key'); await api('/session', 'POST', { key: input.value }); input.value = '';
  await refresh(); $('notice').hidden = true;
}); });
$('logout').addEventListener('click', () => void action(async () => { await api('/session', 'DELETE'); showLogin(); $('notice').hidden = true; }));
$('add-upstream').addEventListener('click', () => editUpstream());
$('add-key').addEventListener('click', () => { document.querySelectorAll('.dialog-error').forEach(e => e.remove()); $<HTMLFormElement>('key-form').reset(); $<HTMLDialogElement>('key-dialog').showModal(); });
document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach(b => b.addEventListener('click', () => $<HTMLDialogElement>(b.dataset.close!).close()));
$<HTMLDialogElement>('created-dialog').addEventListener('close', () => { $<HTMLTextAreaElement>('created-key').value = ''; });
interface AuthTest { results: { authType: string; status: number | null; outcome: 'available' | 'rejected' | 'unknown'; message: string }[] }
const upstreamForm = $<HTMLFormElement>('upstream-form');
upstreamForm.addEventListener('input', () => { $('auth-test-results').hidden = true; });
$('test-auth').addEventListener('click', () => void action(async () => {
  const data = Object.fromEntries(new FormData(upstreamForm));
  const panel = $('auth-test-results'); panel.hidden = false; panel.textContent = '正在检测两种鉴权方式…';
  const inputs = upstreamForm.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select');
  inputs.forEach(input => input.disabled = true);
  try {
    const result = await api<AuthTest>('/test-auth', 'POST', { id: data.id, baseUrl: data.baseUrl, key: data.key });
    panel.replaceChildren();
    for (const item of result.results) {
      const name = item.authType === 'bearer' ? 'Authorization: Bearer' : 'x-api-key';
      const status = item.status === null ? '' : ' · HTTP ' + item.status;
      panel.append(node('p', name + '：' + item.message + status, 'auth-result ' + item.outcome));
    }
    const available = result.results.filter(item => item.outcome === 'available');
    if (available.length === 1) {
      (upstreamForm.elements.namedItem('authType') as HTMLSelectElement).value = available[0].authType;
      panel.append(node('p', '已选中通过的方式，点击保存后生效。', 'hint'));
    } else if (available.length === 2) panel.append(node('p', '两种方式均通过，保留当前选择。', 'hint'));
    else panel.append(node('p', '未确认可用方式，保留当前选择。模型调用权限需另行验证。', 'hint'));
  } catch (e) { panel.textContent = '检测未完成'; throw e; }
  finally { inputs.forEach(input => input.disabled = false); }
}));
$<HTMLFormElement>('upstream-form').addEventListener('submit', e => { e.preventDefault(); void action(async () => {
  const form = $<HTMLFormElement>('upstream-form'); const data = Object.fromEntries(new FormData(form)); const id = data.id as string; delete data.id;
  await api(id ? `/upstreams/${id}` : '/upstreams', id ? 'PATCH' : 'POST', data);
  form.reset(); $<HTMLDialogElement>('upstream-dialog').close(); await refresh(); saved();
}); });
$<HTMLFormElement>('key-form').addEventListener('submit', e => { e.preventDefault(); void action(async () => {
  const data = Object.fromEntries(new FormData($<HTMLFormElement>('key-form')));
  const result = await api<{ key: string }>('/keys', 'POST', data);
  $<HTMLDialogElement>('key-dialog').close();
  $<HTMLTextAreaElement>('created-key').value = result.key;
  $('created-note').textContent = settings.cacheTtlSeconds ? `约 ${settings.cacheTtlSeconds} 秒内生效。` : '';
  $<HTMLDialogElement>('created-dialog').showModal();
  await refresh(); saved();
}); });
async function copy(value: string) { await navigator.clipboard.writeText(value); notify('已复制。'); }
$('copy-url').addEventListener('click', () => void action(() => copy(settings.proxyUrl)));
$('copy-key').addEventListener('click', () => void action(() => copy($<HTMLTextAreaElement>('created-key').value)));
window.addEventListener('hashchange', navigate);
void refresh().catch(e => { showLogin(); if (e.message !== '请使用管理密钥登录') notify(e.message, true); });
