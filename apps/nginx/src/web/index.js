import { toast } from '@fnos/toast';

const BASE = '/app/nginx-for-fnos';
const $ = id => document.getElementById(id);
let selected = '', status = null, latest = null;
function notify(content, type = 'info', duration = 3000) {
  return toast({ content, type, duration, container: document.querySelector('dialog[open]') || document.body });
}
async function api(action, input = {}) {
  const response = await fetch(`${BASE}/api/${action}`, { method: 'POST', headers: { 'x-fnos-request': '1', 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || `请求失败：${response.status}`);
  return data;
}
async function get(action, query = '') {
  const response = await fetch(`${BASE}/api/${action}${query}`, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || `请求失败：${response.status}`);
  return data;
}
async function run(task, success, closeDialogId = '') {
  const pending = notify('正在处理…', 'info', 0);
  try {
    const result = await task();
    await refresh();
    pending.close();
    if (closeDialogId) $(closeDialogId).close();
    notify(result?.warning || result?.message || success, result?.warning ? 'warning' : 'success');
    return result;
  } catch (error) {
    pending.close();
    notify(error.message, 'error');
    return null;
  }
}
function renderLatest() {
  const channel = $('channel').value;
  const matched = latest && latest.channel === channel;
  $('latest-version').textContent = matched ? latest.version : '尚未检查';
  $('latest-detail').textContent = matched ? `${latest.distribution} · ${latest.installed ? '已下载' : latest.updateAvailable ? '有可用更新' : '当前已是较新版本'}` : '点击检查更新获取官方版本';
  $('install-version').disabled = !matched || latest.installed;
  $('install-version').textContent = matched && latest.installed ? '已安装' : '下载并安装';
}
function siteItem(name, enabled) {
  const row = document.createElement('div'); row.className = enabled ? 'site-item' : 'site-item is-disabled';
  const identity = document.createElement('div'); identity.className = 'site-identity';
  const label = document.createElement('span'); label.className = 'site-name'; label.textContent = name; label.title = name;
  identity.append(label);
  if (!enabled) { const state = document.createElement('span'); state.className = 'site-state'; state.textContent = '已禁用'; identity.append(state); }
  const controls = document.createElement('div'); controls.className = 'actions';
  const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '编辑'; edit.setAttribute('aria-label', `编辑 ${name}`);
  edit.addEventListener('click', () => openSite(name));
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = enabled ? '禁用' : '启用'; toggle.setAttribute('aria-label', `${toggle.textContent} ${name}`);
  toggle.addEventListener('click', () => run(() => api('site/enabled', { name, enabled: !enabled }), `站点已${enabled ? '禁用' : '启用'}`));
  controls.append(edit, toggle); row.append(identity, controls); return row;
}
function versionItem(version) {
  const row = document.createElement('div'); row.className = 'version-item';
  const label = document.createElement('span'); const strong = document.createElement('strong'); strong.textContent = version; label.append(strong);
  if (version === status.activeVersion) { const current = document.createElement('em'); current.textContent = '正在使用'; label.append(current); }
  const controls = document.createElement('div'); controls.className = 'actions';
  if (version !== status.activeVersion) {
    const activate = document.createElement('button'); activate.type = 'button'; activate.textContent = '启用'; activate.addEventListener('click', () => run(() => api('version/activate', { version }), '版本已启用'));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger'; remove.textContent = '删除'; remove.addEventListener('click', () => { if (confirm(`删除版本 ${version}？`)) run(() => api('version/remove', { version }), '版本已删除'); });
    controls.append(activate, remove);
  }
  row.append(label, controls); return row;
}
async function refresh() {
  status = await get('status');
  $('running').textContent = status.running ? '运行中' : '已停止';
  $('dot').classList.toggle('on', status.running);
  $('active').textContent = status.activeVersion ? `Nginx ${status.activeVersion}` : '未选择版本';
  $('start').hidden = status.running;
  $('start').disabled = status.running || !status.activeVersion;
  $('stop').hidden = !status.running;
  $('stop').disabled = !status.running;
  $('restart').hidden = !status.running;
  $('restart').disabled = !status.running;
  $('reload').disabled = !status.running;
  const disabledSites = status.disabledSites || [];
  const siteRows = [...status.sites.map(name => siteItem(name, true)), ...disabledSites.map(name => siteItem(name, false))];
  $('site-count').textContent = siteRows.length;
  $('site-list').replaceChildren(...(siteRows.length ? siteRows : [Object.assign(document.createElement('div'), { className: 'empty', textContent: '暂无站点配置，点击右上角新增站点' })]));
  $('version-count').textContent = status.versions.length;
  $('version-list').replaceChildren(...(status.versions.length ? status.versions.map(versionItem) : [Object.assign(document.createElement('span'), { className: 'muted', textContent: '尚未安装版本' })]));
  $('notify-state').textContent = `上次处理时间：${status.lastHandledAt ? new Date(status.lastHandledAt).toLocaleString('zh-CN', { hour12: false }) : '无记录'}`;
  if (latest && latest.channel === $('channel').value) latest.installed = status.versions.includes(latest.version);
  renderLatest();
}
function showDialog() { $('site-dialog').showModal(); $('site-name').focus(); }
function siteBaseName(value) { return value.trim().replace(/\.conf$/i, ''); }
async function openSite(name) {
  try { const data = await get('site', `?name=${encodeURIComponent(name)}`); selected = name; $('dialog-title').textContent = `编辑 ${name}`; $('site-name').value = siteBaseName(name); $('site-name').readOnly = true; $('site-source').value = data.source; $('delete-site').hidden = false; showDialog(); }
  catch (error) { notify(error.message, 'error'); }
}
$('new-site').addEventListener('click', () => {
  selected = ''; $('dialog-title').textContent = '新增站点'; $('site-name').value = ''; $('site-name').readOnly = false; $('delete-site').hidden = true;
  $('site-source').value = 'server {\n    listen 8080;\n    server_name example.com;\n\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n    }\n}\n'; showDialog();
});
$('close-dialog').addEventListener('click', () => $('site-dialog').close());
$('cancel-dialog').addEventListener('click', () => $('site-dialog').close());
$('site-name').addEventListener('change', () => { $('site-name').value = siteBaseName($('site-name').value); });
$('save-site').addEventListener('click', async () => {
  const baseName = siteBaseName($('site-name').value);
  const name = selected || (baseName ? `${baseName}.conf` : '');
  await run(() => api('site/save', { name, source: $('site-source').value }), '配置已校验并保存', 'site-dialog');
});
$('delete-site').addEventListener('click', async () => {
  if (!selected || !confirm(`删除 ${selected}？`)) return;
  await run(() => api('site/delete', { name: selected }), '配置已删除', 'site-dialog');
});
$('edit-config').addEventListener('click', async () => {
  try {
    const data = await get('config');
    $('config-source').value = data.source;
    $('config-dialog').showModal();
    $('config-source').focus();
  } catch (error) { notify(error.message, 'error'); }
});
$('close-config').addEventListener('click', () => $('config-dialog').close());
$('cancel-config').addEventListener('click', () => $('config-dialog').close());
$('save-config').addEventListener('click', () => run(() => api('config/save', { source: $('config-source').value }), '主配置已校验并保存', 'config-dialog'));
$('start').addEventListener('click', () => run(() => api('service/start'), 'Nginx 已启动'));
$('stop').addEventListener('click', () => run(() => api('service/stop'), 'Nginx 已停止'));
$('restart').addEventListener('click', () => run(() => api('service/restart'), 'Nginx 已重启'));
$('reload').addEventListener('click', () => run(() => api('reload'), '配置已校验并发送平滑重载'));
$('channel').addEventListener('change', () => { latest = null; renderLatest(); checkVersion(); });
async function checkVersion() {
  const channel = $('channel').value;
  $('latest-version').textContent = '检查中…'; $('latest-detail').textContent = '正在连接 nginx.org'; $('install-version').disabled = true;
  try { const result = await api('version/check', { channel }); if ($('channel').value === channel) { latest = result; renderLatest(); } }
  catch (error) { if ($('channel').value === channel) { latest = null; $('latest-version').textContent = '无法检查'; $('latest-detail').textContent = '请稍后重试'; notify(error.message, 'error'); } }
}
$('check-version').addEventListener('click', checkVersion);
$('install-version').addEventListener('click', async () => {
  const channel = $('channel').value;
  const result = await run(() => api('version/install', { channel }), '官方版本已下载并安装');
  if (result) { document.querySelector('.installed').open = true; await checkVersion(); }
});
$('save-notify').addEventListener('click', () => run(() => api('notification/settings', { notificationEnabled: $('notify-enabled').checked, notificationPath: $('notify-path').value.trim(), intervalMinutes: Number($('notify-interval').value) }), '通知设置已保存'));
$('test-path').addEventListener('click', () => run(() => api('notification/test', { path: $('notify-path').value.trim() }), '通知文件读写测试通过'));
$('check-notify').addEventListener('click', () => run(() => api('notification/check'), '已检查通知文件'));
try { await refresh(); $('channel').value = status.channel || 'stable'; $('notify-enabled').checked = status.settings.notificationEnabled; $('notify-path').value = status.settings.notificationPath; $('notify-interval').value = status.settings.intervalMinutes; renderLatest(); checkVersion(); }
catch (error) { notify(error.message, 'error'); }
