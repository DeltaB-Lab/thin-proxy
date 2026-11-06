import { enhanceSelect } from './select';
interface Upstream { id: string; name: string; baseUrl: string; modelCatalogUrl?: string; authType: string }
interface KeyInfo { enabled: boolean; id: string; name: string; keyPrefix: string; createdAt: string; upstreamId: string | null; canReveal: boolean }
interface Settings { proxyUrl: string; activeUpstreamId: string | null; cacheTtlSeconds: number }
interface ManagementSnapshot { config: Settings; upstreams: Upstream[]; keys: KeyInfo[] }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let settings: Settings;
let upstreams: Upstream[] = [];
let busy = false;
const selects = Array.from(document.querySelectorAll('select'), enhanceSelect);
function refreshSelects() { selects.forEach(select => select.refresh()); }
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
  finally { busy = false; document.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false); refreshSelects(); }
}
function node(tag: string, text?: string, className?: string): HTMLElement {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
  if (className) el.className = className; return el;
}
function button(text: string, className: string, handler: () => void) {
  const el = document.createElement('button'); el.type = 'button'; el.textContent = text; el.className = className; el.addEventListener('click', handler); return el;
}
function saved() { notify(settings.cacheTtlSeconds ? `已保存，约 ${settings.cacheTtlSeconds} 秒内生效。` : '已保存。'); }
function setUpstreamKeyVisible(visible: boolean) {
  $<HTMLInputElement>('upstream-key').type = visible ? 'text' : 'password';
  const toggle = $('toggle-upstream-key');
  const label = visible ? '隐藏 Key' : '显示 Key';
  toggle.setAttribute('aria-label', label); toggle.setAttribute('aria-pressed', String(visible)); toggle.title = label;
  $('upstream-key-eye-slash').toggleAttribute('hidden', !visible);
}
function editUpstream(upstream?: Upstream) {
  document.querySelectorAll('.dialog-error').forEach(e => e.remove());
  const form = $<HTMLFormElement>('upstream-form'); form.reset();
  setUpstreamKeyVisible(false);
  $('auth-test-results').hidden = true; $('auth-test-results').replaceChildren();
  const set = (name: string, value: string) => (form.elements.namedItem(name) as HTMLInputElement).value = value;
  set('id', upstream?.id ?? ''); set('name', upstream?.name ?? ''); set('baseUrl', upstream?.baseUrl ?? ''); set('authType', upstream?.authType ?? 'bearer');
  set('modelCatalogUrl', upstream?.modelCatalogUrl ?? '');
  (form.elements.namedItem('key') as HTMLInputElement).required = !upstream;
  $('upstream-title').textContent = upstream ? '编辑上游' : '添加上游'; $('edit-key-hint').hidden = !upstream;
  refreshSelects();
  $<HTMLDialogElement>('upstream-dialog').showModal();
}
function editKey(key?: KeyInfo) {
  document.querySelectorAll('.dialog-error').forEach(e => e.remove());
  const form = $<HTMLFormElement>('key-form'); form.reset();
  (form.elements.namedItem('id') as HTMLInputElement).value = key?.id ?? '';
  const name = form.elements.namedItem('name') as HTMLInputElement;
  name.value = key?.name ?? '';
  const defaultName = upstreams.find(u => u.id === settings.activeUpstreamId)?.name ?? '未选择';
  const select = $<HTMLSelectElement>('key-upstream-id');
  const choices = [{ id: '', name: `跟随默认上游（${defaultName}）` }, ...upstreams];
  select.replaceChildren(...choices.map(({ id, name }) => {
    const option = document.createElement('option'); option.value = id; option.textContent = name; return option;
  }));
  select.value = key?.upstreamId ?? '';
  refreshSelects();
  $('key-title').textContent = key ? '编辑 Key' : '创建 Key';
  $('key-submit').textContent = key ? '保存' : '创建';
  $<HTMLDialogElement>('key-dialog').showModal();
}
function showKey(key: string, title: string) {
  $('key-secret-title').textContent = title;
  $<HTMLTextAreaElement>('created-key').value = key;
  $('created-note').textContent = '可随时从 Key 列表再次查看或复制。';
  $<HTMLDialogElement>('created-dialog').showModal();
}
async function refresh() {
  const { config, upstreams: list, keys } = await api<ManagementSnapshot>('/snapshot');
  settings = config; upstreams = list;
  $('upstream-count').textContent = String(list.length); $('key-count').textContent = String(keys.length);
  $('proxy-url').textContent = settings.proxyUrl;
  $('current-upstream').textContent = list.find(u => u.id === settings.activeUpstreamId)?.name ?? '未选择';
  $('ttl-note').textContent = String(settings.cacheTtlSeconds);
  const cards = $('upstream-list'); cards.replaceChildren();
  if (!list.length) cards.append(node('div', '暂无上游', 'empty'));
  for (const u of list) {
    const active = u.id === settings.activeUpstreamId;
    const card = node('article', undefined, `upstream-card${active ? ' active' : ''}`);
    const heading = node('div', undefined, 'card-title'); heading.append(node('h3', u.name)); if (active) heading.append(node('span', '默认上游', 'badge'));
    card.append(heading, node('p', u.baseUrl, 'muted'), node('span', u.authType === 'bearer' ? 'Authorization: Bearer' : 'x-api-key', 'tag'));
    const actions = node('div', undefined, 'actions');
    actions.append(button(active ? '取消默认' : '设为默认', active ? 'quiet small' : 'small', () => void action(async () => {
      if (active && !confirm('取消后，跟随默认上游的 Key 将无法回源。已指定上游的 Key 不受影响。确定取消？')) return;
      await api('/active-upstream', 'PUT', { id: active ? null : u.id }); await refresh(); saved();
    })), button('编辑', 'quiet small', () => editUpstream(u)), button('删除', 'quiet small danger', () => void action(async () => {
      if (active) { notify('请先切换或取消默认上游，再删除。', true); return; }
      if (keys.some(key => key.upstreamId === u.id)) { notify('请先修改绑定此上游的转发 Key，再删除。', true); return; }
      if (!confirm(`删除上游“${u.name}”？`)) return;
      await api(`/upstreams/${u.id}`, 'DELETE'); await refresh(); saved();
    })));
    card.append(actions); cards.append(card);
  }
  const rows = $('key-list'); rows.replaceChildren();
  if (!keys.length) rows.append(node('div', '暂无 Key', 'empty'));
  for (const key of keys) {
    const row = node('div', undefined, 'key-row'); const info = node('div');
    info.append(node('span', key.enabled ? '服务中' : '已停止服务', key.enabled ? 'badge' : 'tag'), node('strong', key.name), node('p', `${key.keyPrefix}… · ${new Date(key.createdAt).toLocaleString()}`));
    info.append(node('p', key.upstreamId
      ? `指定上游：${list.find(u => u.id === key.upstreamId)?.name ?? '上游不可用'}`
      : `跟随默认上游：${list.find(u => u.id === settings.activeUpstreamId)?.name ?? '未选择'}`));
    const actions = node('div', undefined, 'actions');
    if (key.canReveal) {
      actions.append(button('查看', 'quiet small', () => void action(async () => {
        const result = await api<{ key: string }>(`/keys/${key.id}/reveal`, 'POST'); showKey(result.key, key.name);
      })), button('复制', 'quiet small', () => void action(async () => {
        const result = await api<{ key: string }>(`/keys/${key.id}/reveal`, 'POST');
        try { await copy(result.key); } catch { showKey(result.key, key.name); notify('无法自动复制，请在弹窗中手动复制。'); }
      })));
    } else info.append(node('p', '旧 Key 未保存可恢复副本，无法查看明文。'));
    actions.append(button(key.enabled ? '停止服务' : '恢复服务', key.enabled ? 'quiet small danger' : 'small', () => void action(async () => {
      await api(`/keys/${key.id}`, 'PATCH', { enabled: !key.enabled }); await refresh();
      notify(`已${key.enabled ? '停止' : '恢复'}此 Key 的服务，其他实例约 ${settings.cacheTtlSeconds} 秒内同步。已建立的连接不受影响。`);
    })), button('编辑', 'quiet small', () => editKey(key)), button('撤销', 'quiet small danger', () => void action(async () => {
      if (!confirm(`撤销“${key.name}”？此操作不可恢复。`)) return;
      await api(`/keys/${key.id}`, 'DELETE'); await refresh(); saved();
    }))); row.append(info, actions); rows.append(row);
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
$('toggle-upstream-key').addEventListener('click', () => setUpstreamKeyVisible($<HTMLInputElement>('upstream-key').type === 'password'));
$('add-key').addEventListener('click', () => editKey());
document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach(b => b.addEventListener('click', () => $<HTMLDialogElement>(b.dataset.close!).close()));
$<HTMLDialogElement>('created-dialog').addEventListener('close', () => { $<HTMLTextAreaElement>('created-key').value = ''; });
$<HTMLDialogElement>('upstream-dialog').addEventListener('close', () => {
  $<HTMLInputElement>('upstream-key').value = ''; setUpstreamKeyVisible(false);
});
interface AuthTest { results: { authType: string; status: number | null; outcome: 'available' | 'rejected' | 'unknown'; message: string; models?: string[] }[] }
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
      if (item.models !== undefined) {
        panel.append(node('p', `返回模型（${item.models.length}）`, 'hint'));
        if (!item.models.length) panel.append(node('p', '模型列表为空。', 'hint'));
        else {
          const list = node('ul', undefined, 'auth-models');
          list.setAttribute('aria-label', `${name} 返回的模型`);
          item.models.forEach(model => list.append(node('li', model)));
          panel.append(list);
        }
      }
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
  const upstreamId = data.upstreamId || null;
  if (data.id) {
    await api(`/keys/${data.id}`, 'PATCH', { name: data.name, upstreamId });
    $<HTMLDialogElement>('key-dialog').close(); await refresh(); saved(); return;
  }
  const result = await api<{ key: string }>('/keys', 'POST', { name: data.name, upstreamId });
  $<HTMLDialogElement>('key-dialog').close();
  showKey(result.key, 'Key 已创建');
  await refresh(); saved();
}); });
async function copy(value: string) { await navigator.clipboard.writeText(value); notify('已复制。'); }
$('copy-url').addEventListener('click', () => void action(() => copy(settings.proxyUrl)));
$('copy-key').addEventListener('click', () => void action(() => copy($<HTMLTextAreaElement>('created-key').value)));
window.addEventListener('hashchange', navigate);
void refresh().catch(e => { showLogin(); if (e.message !== '请使用管理密钥登录') notify(e.message, true); });
