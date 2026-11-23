import { encryptCredential } from '@fnos/privilege/client';

const BASE = '/app/dnsmasq-for-fnos/api';
const $ = selector => document.querySelector(selector);
const state = { status: null, diagnostics: null, busy: false, settingsDirty: false };
let credentialKey = null;

const toast = message => {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 3600);
};

async function getCredentialKey() {
  if (credentialKey) return credentialKey;
  const response = await fetch(`${BASE}/credential-key`, { cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.publicKey) throw Error('凭据通道不可用，请刷新页面后重试');
  credentialKey = data.publicKey;
  return credentialKey;
}

async function request(path, { method = 'GET', body } = {}) {
  let payload = body;
  if (payload && typeof payload.password === 'string' && payload.password) {
    payload = { ...payload, password: undefined, encryptedCredential: await encryptCredential(payload.password, await getCredentialKey()) };
  }
  const response = await fetch(`${BASE}/${path}`, {
    method,
    cache: 'no-store',
    headers: payload === undefined ? undefined : { 'content-type': 'application/json', 'x-fnos-request': '1' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (/凭据/.test(data?.error || '')) credentialKey = null;
    throw Error(data?.error || `请求失败（HTTP ${response.status}）`);
  }
  return data;
}
const api = path => request(path);
const send = (path, payload = {}) => request(path, { method: 'POST', body: payload });

function setBusy(value) {
  state.busy = value;
  for (const button of document.querySelectorAll('.top-actions button, #settings-form button, #record-form button, #add-record, .records button')) button.disabled = value;
}

function formatStarted(timestamp) {
  if (!timestamp) return '';
  try { return new Date(timestamp).toLocaleString(); } catch { return ''; }
}

function showAlert(message, { fix = false } = {}) {
  const box = $('#alert');
  box.replaceChildren();
  if (!message) { box.classList.add('hidden'); return; }
  const text = document.createElement('span');
  text.textContent = message;
  box.append(text);
  if (fix) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small';
    button.textContent = '初始化运行权限';
    button.addEventListener('click', () => authorizePrivileges({ thenStart: true }));
    box.append(button);
  }
  box.classList.remove('hidden');
}

function renderStatus(status) {
  state.status = status;
  const running = Boolean(status.running);
  $('#service-state').textContent = running ? '运行中' : '已停止';
  $('#status-dot').className = `dot ${running ? 'on' : status.lastError ? 'error' : ''}`;
  $('#top-detail').textContent = running ? `PID ${status.pid} · ${formatStarted(status.startedAt)} 启动` : '服务未运行';
  if (running) $('#service-detail').textContent = 'dnsmasq 正在提供 DNS 解析服务';
  else if (status.lastError) $('#service-detail').textContent = '上次启动未成功，查看上方提示后重试';
  else if (!status.platformSupported) $('#service-detail').textContent = '当前平台不支持运行 dnsmasq';
  else $('#service-detail').textContent = '启动后即可响应 DNS 查询';
  $('#start').classList.toggle('hidden', running);
  $('#stop').classList.toggle('hidden', !running);
  $('#restart').classList.toggle('hidden', !running);
  $('#listen-summary').textContent = status.settings.listenAddresses.join('、') || '—';
  $('#upstream-summary').textContent = status.settings.upstreams.join('、') || '—';
  $('#record-summary').textContent = `${status.records.length} 条`;
  $('#cache-summary').textContent = status.settings.cacheSize === 0 ? '已禁用' : String(status.settings.cacheSize);
  const message = !running && status.lastError ? status.lastError : '';
  const fix = Boolean(message) && /权限|CAP_NET/.test(message) && !/占用/.test(message);
  showAlert(message, { fix });
}

function renderSettings(status) {
  $('#listen').value = status.settings.listenAddresses.join('\n');
  $('#upstreams').value = status.settings.upstreams.join('\n');
  $('#cache').value = status.settings.cacheSize;
  $('#logging').checked = status.settings.queryLogging;
  $('#auto').checked = status.settings.autoStart;
  $('#hosts-sync').checked = Boolean(status.settings.hostsSync);
  $('#hosts-sync').disabled = !status.platformSupported;
}

function recordRow(record, index) {
  const row = document.createElement('div');
  row.className = 'record';
  const main = document.createElement('div');
  main.className = 'record-main';
  const title = document.createElement('strong');
  title.textContent = `${record.type === 'exact' ? '精确' : '后缀'} · ${record.domain}`;
  const addresses = document.createElement('span');
  addresses.className = 'record-addresses';
  addresses.textContent = record.addresses.join('、');
  main.append(title, addresses);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger small';
  remove.textContent = '删除';
  remove.setAttribute('aria-label', `删除 ${record.domain}`);
  remove.addEventListener('click', async () => {
    if (!confirm(`确定删除 ${record.domain} 吗？`)) return;
    try { await send('records/delete', { index }); toast('记录已删除'); await refresh(); } catch (error) { toast(error.message); }
  });
  row.append(main, remove);
  return row;
}

function renderRecords(records) {
  const list = $('#records-list');
  list.replaceChildren();
  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '暂无自定义解析记录';
    list.append(empty);
    return;
  }
  records.forEach((record, index) => list.append(recordRow(record, index)));
}

async function refresh() {
  const status = await api('status');
  renderStatus(status);
  if (!state.settingsDirty) renderSettings(status);
  renderRecords(status.records);
  return status;
}

function diagnosticRow(list, label, value, tone = '') {
  const row = document.createElement('div');
  row.className = 'diag-row';
  const name = document.createElement('dt');
  name.textContent = label;
  const detail = document.createElement('dd');
  if (tone) detail.className = tone;
  detail.textContent = value;
  row.append(name, detail);
  list.append(row);
}

function detailsBlock(title, text) {
  const details = document.createElement('details');
  details.className = 'diag-details';
  const summary = document.createElement('summary');
  summary.textContent = title;
  const pre = document.createElement('pre');
  pre.textContent = text || '（空）';
  details.append(summary, pre);
  return details;
}

function diagAction(noteText, buttonText, handler) {
  const action = document.createElement('div');
  action.className = 'diag-action';
  const note = document.createElement('span');
  note.textContent = noteText;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary small';
  button.textContent = buttonText;
  button.addEventListener('click', handler);
  action.append(note, button);
  return action;
}

function renderDiagnostics(data) {
  const body = $('#diagnostic-body');
  body.replaceChildren();
  const list = document.createElement('dl');
  list.className = 'diag-list';
  diagnosticRow(list, '服务状态', data.running ? '运行中' : '已停止', data.running ? 'ok' : '');
  diagnosticRow(list, '运行权限', data.helperReady ? '已初始化' : '未初始化', data.helperReady ? 'ok' : 'warn');
  diagnosticRow(list, '53 端口能力', data.capability === true ? '已授予' : data.capability === false ? '未授予' : '未知', data.capability === true ? 'ok' : data.capability === false ? 'warn' : '');
  diagnosticRow(list, '运行平台', `${data.platform}${data.platformSupported ? '' : '（不支持）'}`, data.platformSupported ? '' : 'warn');
  diagnosticRow(list, 'dnsmasq', `${data.binary}${data.binaryExists ? '' : '（缺失）'}`, data.binaryExists ? '' : 'bad');
  diagnosticRow(list, 'NAS hosts', !data.settings?.hostsSync ? '未启用' : data.hostsSyncActive ? '已同步' : '已启用，未写入', !data.settings?.hostsSync ? '' : data.hostsSyncActive ? 'ok' : 'warn');
  if (data.capabilityError) diagnosticRow(list, '权限错误', data.capabilityError, 'bad');
  if (data.hostsSyncError) diagnosticRow(list, 'hosts 错误', data.hostsSyncError, 'bad');
  if (data.lastError) diagnosticRow(list, '最近错误', data.lastError, 'bad');
  body.append(list);

  if (!data.helperReady || data.capability === false) {
    body.append(diagAction(data.helperReady ? '53 端口能力尚未授予，需要管理员授权一次。' : '运行权限尚未初始化，需要管理员授权一次。', data.helperReady ? '重新授予权限' : '初始化运行权限', () => authorizePrivileges({ thenStart: true })));
  }
  if (data.settings?.hostsSync && (!data.hostsSyncActive || data.hostsSyncError)) {
    body.append(diagAction('NAS hosts 同步未生效，可重新写入一次。', '重新同步 hosts', () => toggleHostsSync(true)));
  }

  body.append(detailsBlock('生成的配置', data.config));
  if (data.settings?.hostsSync) body.append(detailsBlock('hosts 同步内容', data.hostsSnippet));
  body.append(detailsBlock('最近日志', data.lastOutput || data.logTail));
}

async function loadDiagnostics() {
  const button = $('#diagnose');
  button.disabled = true;
  try {
    const data = await api('diagnostics');
    state.diagnostics = data;
    renderDiagnostics(data);
    $('#diagnostic-body').classList.remove('hidden');
    button.textContent = '刷新诊断';
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

function askPassword(title, text) {
  return new Promise(resolve => {
    const modal = $('#password-modal');
    const input = $('#password-input');
    $('#password-title').textContent = title;
    $('#password-text').textContent = text;
    input.value = '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 0);
    const finish = value => {
      modal.classList.add('hidden');
      input.removeEventListener('keydown', onKey);
      $('#password-cancel').removeEventListener('click', cancel);
      $('#password-accept').removeEventListener('click', accept);
      modal.removeEventListener('click', backdrop);
      resolve(value);
    };
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); finish(null); }
      else if (event.key === 'Enter') { event.preventDefault(); finish(input.value); }
    };
    const cancel = () => finish(null);
    const accept = () => finish(input.value);
    const backdrop = event => { if (event.target === modal) finish(null); };
    input.addEventListener('keydown', onKey);
    $('#password-cancel').addEventListener('click', cancel);
    $('#password-accept').addEventListener('click', accept);
    modal.addEventListener('click', backdrop);
  });
}

async function authorizePrivileges({ thenStart = false } = {}) {
  if (state.busy) return false;
  const password = await askPassword('管理员授权', '初始化 dnsmasq 运行权限需要授予 53 端口绑定能力。请输入当前 NAS 管理员密码，密码仅用于本次提权且不会被保存。');
  if (!password) return false;
  setBusy(true);
  let initialized = false;
  try {
    await send('privilege/init', { password });
    toast('运行权限已初始化');
    initialized = true;
  } catch (error) {
    toast(error.message);
  } finally { setBusy(false); }
  if (!initialized) { await refresh(); return false; }
  if (thenStart) await startService(true);
  else { await refresh(); await loadDiagnostics(); }
  return true;
}

async function toggleHostsSync(enabled) {
  const input = $('#hosts-sync');
  input.disabled = true;
  const apply = password => send('hosts/sync', password ? { enabled, password } : { enabled });
  try {
    await apply('');
    toast(enabled ? '已同步到 NAS hosts' : '已移除 NAS hosts 同步');
    await refresh();
  } catch (error) {
    if (/运行权限未初始化|管理员|权限|sudo|密码/.test(error.message)) {
      const password = await askPassword('管理员授权', '同步 NAS hosts 需要管理员授权一次。请输入当前 NAS 管理员密码，密码仅用于本次提权且不会被保存。');
      if (password) {
        try { await apply(password); toast(enabled ? '已同步到 NAS hosts' : '已移除 NAS hosts 同步'); await refresh(); }
        catch (retry) { toast(retry.message); await refresh(); }
      } else { await refresh(); }
    } else {
      toast(error.message);
      await refresh();
    }
  } finally {
    input.checked = Boolean(state.status?.settings.hostsSync);
    input.disabled = !state.status?.platformSupported;
  }
}

async function startService(authorized = false) {
  if (state.busy) return;
  setBusy(true);
  let failure = null;
  try {
    await send('service/start');
    toast('DNS 服务已启动');
  } catch (error) { failure = error; toast(error.message); }
  finally { setBusy(false); }
  await refresh();
  if (!$('#diagnostic-body').classList.contains('hidden')) await loadDiagnostics();
  if (!failure || authorized) return;
  if (/权限|CAP_NET|初始化/.test(failure.message)) {
    const data = await api('diagnostics').catch(() => null);
    if (data && (data.helperReady === false || data.capability !== true)) await authorizePrivileges({ thenStart: true });
  }
}

async function stopService() {
  if (state.busy) return;
  setBusy(true);
  try { await send('service/stop'); toast('DNS 服务已停止'); await refresh(); if (!$('#diagnostic-body').classList.contains('hidden')) await loadDiagnostics(); }
  catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

async function restartService() {
  if (state.busy) return;
  setBusy(true);
  try { await send('service/restart'); toast('DNS 服务已重启'); await refresh(); if (!$('#diagnostic-body').classList.contains('hidden')) await loadDiagnostics(); }
  catch (error) { toast(error.message); await refresh(); }
  finally { setBusy(false); }
}

document.querySelectorAll('.tabs button').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(node => node.classList.toggle('active', node === button));
  document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === button.dataset.page));
}));

$('#start').addEventListener('click', () => startService(false));
$('#stop').addEventListener('click', stopService);
$('#restart').addEventListener('click', restartService);
$('#diagnose').addEventListener('click', loadDiagnostics);
$('#hosts-sync').addEventListener('change', event => toggleHostsSync(event.target.checked));

for (const selector of ['#listen', '#upstreams', '#cache', '#logging', '#auto']) {
  $(selector).addEventListener('input', () => { state.settingsDirty = true; });
  $(selector).addEventListener('change', () => { state.settingsDirty = true; });
}

$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  setBusy(true);
  try {
    await send('settings/save', {
      listenAddresses: $('#listen').value.split(/\s+/).filter(Boolean),
      upstreams: $('#upstreams').value.split(/\s+/).filter(Boolean),
      cacheSize: Number($('#cache').value),
      queryLogging: $('#logging').checked,
      autoStart: $('#auto').checked,
    });
    state.settingsDirty = false;
    await refresh();
    toast('设置已保存');
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
});

$('#add-record').addEventListener('click', () => {
  $('#record-form').classList.remove('hidden');
  $('#record-domain').focus();
});
$('#cancel-record').addEventListener('click', () => $('#record-form').classList.add('hidden'));
$('#record-form').addEventListener('submit', async event => {
  event.preventDefault();
  const current = state.status?.records || [];
  const next = [...current, {
    type: $('#record-type').value,
    domain: $('#record-domain').value,
    addresses: $('#record-addresses').value.split(',').map(value => value.trim()).filter(Boolean),
  }];
  setBusy(true);
  try {
    await send('records/save', { records: next });
    $('#record-form').reset();
    $('#record-form').classList.add('hidden');
    await refresh();
    toast('记录已添加');
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
});

refresh().catch(error => toast(error.message));
