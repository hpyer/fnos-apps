import { toast } from '@fnos/toast';
import { watchAppUpdates } from '@fnos/version-check/client';
import {
  configKindLabel, connectionTarget, delayLevel, delayText, formatBytes, formatClock,
  formatDuration, formatTime, levelLabel, modeLabel, truncate,
} from './format.mjs';

const BASE = '/app/clash-for-fnos';
const $ = id => document.getElementById(id);
const LOG_LEVELS = { debug: 0, info: 1, warning: 2, error: 3 };
const state = {
  status: null,
  proxies: null,
  connections: { connections: [], uploadTotal: 0, downloadTotal: 0 },
  logs: [],
  view: 'overview',
  configLoaded: false,
  configDirty: false,
  settingsDirty: false,
  starting: false,
  data: null,
  jobState: 'idle',
  preparation: null,
  prepareTimer: 0,
  prepareWatchUntil: 0,
  prepareStartedAt: 0,
  prepareCollapsed: false,
  editingSubscription: '',
  localNodesOpen: false,
  expandedProviders: new Set(),
  expandedGroups: new Set(),
  initializedProxies: false,
  logTimer: 0,
  currentConnection: null,
  lastError: '',
};

function notify(content, type = 'info', duration) {
  const options = { content, type, container: document.querySelector('dialog[open]') || document.body };
  if (duration !== undefined) options.duration = duration;
  return toast(options);
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function button(label, { className = '', onClick, disabled = false, title = '' } = {}) {
  const element = node('button', label, className);
  element.type = 'button';
  element.disabled = disabled;
  if (title) element.title = title;
  if (onClick) element.addEventListener('click', onClick);
  return element;
}

function iconButton(title, pathMarkup, onClick, className = 'icon-control') {
  const element = node('button', '', className);
  element.type = 'button';
  element.title = title;
  element.setAttribute('aria-label', title);
  element.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${pathMarkup}</svg>`;
  element.addEventListener('click', onClick);
  return element;
}

let credentialKey = null;

async function ensureCredentialKey() {
  if (credentialKey) return credentialKey;
  const response = await fetch(`${BASE}/api/credential-key`, { cache: 'no-store' });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.publicKey) throw Error('凭据通道不可用');
  credentialKey = payload;
  return credentialKey;
}

/**
 * Encrypt the password with an ephemeral ECDH key so it never travels in plaintext.
 * Uses @noble/curves instead of WebCrypto: fnOS serves the page over plain HTTP on a
 * LAN address, where crypto.subtle is unavailable (secure-context restriction).
 */
async function encryptCredential(password) {
  const { p256 } = await import('@noble/curves/nist.js');
  const { hkdf } = await import('@noble/hashes/hkdf.js');
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { gcm } = await import('@noble/ciphers/aes.js');
  const { randomBytes } = await import('@noble/hashes/utils.js');
  const key = await ensureCredentialKey();
  const serverJwk = JSON.parse(key.publicKey);
  const serverX = base64ToBytes(serverJwk.x);
  const serverY = base64ToBytes(serverJwk.y);
  const serverPoint = new Uint8Array(65);
  serverPoint[0] = 0x04;
  serverPoint.set(serverX, 1);
  serverPoint.set(serverY, 33);
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, false);
  const shared = p256.getSharedSecret(priv, serverPoint).slice(1);
  const aesKey = hkdf(sha256, shared, new Uint8Array(32), new Uint8Array(0), 32);
  const iv = randomBytes(12);
  const sealed = gcm(aesKey, iv).encrypt(new TextEncoder().encode(password));
  return {
    ephemeralPublicKey: bytesToBase64(pub),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(sealed.slice(-16)),
    data: bytesToBase64(sealed.slice(0, -16)),
  };
}

function base64ToBytes(value) {
  // Accept both base64 and base64url (fnOS JWK keys use base64url without padding).
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value).length / 4) * 4, '=');
  return Uint8Array.from(atob(normalized), ch => ch.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function request(path, { method = 'GET', body, query = '' } = {}) {
  let payload = body;
  if (payload && typeof payload.password === 'string' && payload.password) {
    const encryptedCredential = await encryptCredential(payload.password);
    payload = { ...payload, password: undefined, encryptedCredential };
  } else if (payload && typeof payload.password === 'string') {
    payload = { ...payload, password: undefined };
  }
  const response = await fetch(`${BASE}/api/${path}${query}`, {
    method,
    cache: 'no-store',
    ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json', 'x-fnos-request': '1' }, body: JSON.stringify(payload) }),
  });
  let result;
  try { result = await response.json(); } catch { result = null; }
  if (response.status === 400 && /凭据/.test(result?.error || '')) credentialKey = null;
  if (!response.ok) throw Error(result?.error || `请求失败：HTTP ${response.status}`);
  return result;
}

const get = (path, query) => request(path, { query });
const post = (path, body = {}) => request(path, { method: 'POST', body });

async function act(task, successMessage, { silent = false } = {}) {
  try {
    const result = await task();
    if (successMessage && !silent) notify(successMessage, 'success');
    return result;
  } catch (error) {
    state.lastError = error.message;
    if (!silent) notify(error.message, 'error', 6500);
    return null;
  }
}

/** Run a privileged task; on permission failure ask for the admin password once and retry. */
async function privilegedAct(task, successMessage, { silent = false, softError = false } = {}) {
  const first = await act(task, '', { silent: true });
  if (first) {
    if (successMessage && !silent) notify(successMessage, 'success');
    return first;
  }
  const error = state.lastError;
  if (!error) return null;
  if (!/需要 root|服务模式未初始化|拒绝提权|权限|管理员/.test(error)) {
    if (!softError) notify(error, 'error', 6500);
    return null;
  }
  const password = await askPassword('管理员授权', '此操作需要 NAS 管理员权限。请输入管理员账号的密码以完成一次提权（密码不会被保存）。');
  if (password === null) return null;
  const retry = await act(() => task(password), successMessage, { silent });
  return retry;
}

function showView(view) {
  state.view = view;
  for (const item of document.querySelectorAll('.nav-item')) item.classList.toggle('is-active', item.dataset.view === view);
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`;
  if (view === 'proxies') refreshProxies();
  if (view === 'connections') refreshConnections();
  if (view === 'config') ensureConfig();
  if (view === 'logs') scheduleLogRender();
  if (view === 'settings') { renderSettingsForm(true); renderCoreVersions(); renderJob(); refreshData().catch(() => {}); }
}

/* ---------------------------------------------------------------- status */

function coreStateText(core) {
  return { running: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止', error: '未运行' }[core?.state] || '读取中';
}

function dotClass(stateValue) {
  if (stateValue === 'running') return 'dot on';
  if (stateValue === 'starting' || stateValue === 'stopping') return 'dot warn';
  if (stateValue === 'error') return 'dot error';
  return 'dot';
}

function updateTraffic(traffic) {
  if (!traffic) return;
  $('rate-down').textContent = formatBytes(traffic.down, { rate: true });
  $('rate-up').textContent = formatBytes(traffic.up, { rate: true });
}

function portText(ports = {}) {
  const entries = Object.entries(ports).filter(([, port]) => port > 0);
  if (!entries.length) return '未配置';
  const labels = { mixed: '混合', http: 'HTTP', socks: 'SOCKS', redir: 'REDIR', tproxy: 'TProxy' };
  return entries.slice(0, 2).map(([name, port]) => `${port} ${labels[name] || name}`).join(' · ') + (entries.length > 2 ? ' …' : '');
}

function renderSidebar(status) {
  const core = status.core;
  const starting = state.starting === true || core.state === 'starting';
  $('side-dot').className = starting ? 'dot warn' : dotClass(core.state);
  $('side-state').textContent = starting ? '启动中' : coreStateText(core);
  const version = core.activeVersion || core.version || '';
  $('side-core').textContent = core.activeTypeLabel ? `${core.activeTypeLabel}${version ? ` ${version.startsWith('v') ? version : `v${version}`}` : ''}` : '未选择内核';
  $('side-start').hidden = core.state === 'running' || core.state === 'stopping';
  $('side-stop').hidden = core.state !== 'running';
  $('side-restart').hidden = core.state !== 'running';
  $('side-start').classList.toggle('is-loading', starting);
  $('side-start').setAttribute('aria-busy', starting ? 'true' : 'false');
  for (const item of [$('side-start'), $('side-stop'), $('side-restart')]) item.disabled = starting || core.state === 'stopping' || !status.platform.supported;
  $('side-start').title = starting ? '启动中…' : status.platform.supported ? '启动' : '本机预览无法启动 Linux 内核';
  for (const item of document.querySelectorAll('.side-modes button')) item.classList.toggle('is-active', item.dataset.mode === core.mode);
  $('side-version').textContent = `v${status.version}`;
  $('side-platform').textContent = status.platform.arch === 'x64' ? 'x86_64' : status.platform.arch === 'arm64' ? 'ARM64' : status.platform.arch;
  const environment = status.environment || {};
  const proxyDesired = environment.systemProxyDesired === true || environment.systemProxy === true;
  const tunDesired = environment.tunDesired === true || environment.tunConfigured === true;
  $('toggle-system-proxy').checked = proxyDesired;
  $('toggle-tun').checked = tunDesired;
  $('set-system-proxy').checked = proxyDesired;
  $('set-tun').checked = tunDesired;
  const proxyTitle = environment.systemProxy
    ? 'NAS 系统代理已开启'
    : proxyDesired ? '已设置，启动 Core 后自动开启系统代理'
    : environment.systemProxyWritable ? '系统代理未开启' : '系统代理未开启（修改 /etc/environment 需要 root/sudo）';
  $('toggle-system-proxy').title = proxyTitle;
  $('set-system-proxy').title = proxyTitle;
  const tunTitle = environment.tunEnabled
    ? `增强模式已开启（TUN 网卡 ${environment.tunDevice || 'Meta'}）`
    : tunDesired ? '已设置，启动 Core 后自动开启增强模式'
    : '增强模式未开启';
  $('toggle-tun').title = tunTitle;
  $('set-tun').title = tunTitle;
}

function renderMetrics(status) {
  const core = status.core;
  const traffic = core.traffic || {};
  updateTraffic(traffic);
  $('total-down').textContent = formatBytes(core.totals?.down);
  $('total-up').textContent = formatBytes(core.totals?.up);
  $('memory').textContent = core.running && core.memory ? formatBytes(core.memory) : '—';
  $('connections-count').textContent = core.running ? String(core.connections || 0) : '0';
  $('uptime').textContent = core.running ? formatDuration(core.uptimeMs) : '—';
  $('started-at').textContent = core.startedAt ? `启动于 ${formatTime(core.startedAt)}` : '—';
  $('ports').textContent = portText(core.ports);
  $('allow-lan').textContent = core.allowLan ? '允许局域网访问' : '仅本机访问';
  $('quick-delay').disabled = !core.running;
}

function renderQuickGroup() {
  const container = $('quick-group');
  const mode = state.status?.core.mode || 'rule';
  const groups = (state.proxies?.groups || []).filter(group => !group.hidden);
  const selector = mode === 'global'
    ? groups.find(group => group.name === 'GLOBAL') || groups[0]
    : groups.find(group => group.type === 'Selector' && group.name !== 'GLOBAL') || groups.find(group => group.name !== 'GLOBAL') || groups[0];
  if (!selector) {
    container.replaceChildren(node('p', state.status?.core.running ? '配置中没有代理组' : 'Core 运行后显示代理组', 'empty'));
    return;
  }
  const head = node('div', '', 'quick-group-head');
  head.append(node('strong', selector.name), node('span', `${selector.type} · 当前 ${selector.now || '—'}`, 'muted'));
  const chips = node('div', '', 'quick-group-list');
  for (const name of selector.all.slice(0, 24)) {
    const detail = state.proxies?.proxies?.[name];
    const chip = node('button', '', 'chip');
    chip.type = 'button';
    chip.append(node('span', name));
    if (detail) chip.append(node('span', delayText(detail.delay), `delay ${delayLevel(detail.delay)}`));
    if (name === selector.now) chip.classList.add('is-active');
    if (selector.type === 'Selector') {
      chip.addEventListener('click', async () => {
        const result = await act(() => post('proxy/select', { group: selector.name, name }), `已切换到 ${name}`);
        if (result) refreshProxies();
      });
    } else chip.disabled = true;
    chips.append(chip);
  }
  container.replaceChildren(head, chips);
}

function handleJobTransition(job) {
  if (!job) return;
  if (state.jobState === 'running' && job.state === 'success') notify(job.message || '内核操作完成', 'success', 5000);
  if (state.jobState === 'running' && job.state === 'error') notify(job.message || '内核操作失败', 'error', 7000);
  state.jobState = job.state;
}

async function refreshStatus() {
  if (document.hidden) return;
  try {
    const status = await get('status');
    if (!status.core.running) {
      state.proxies = null;
      state.initializedProxies = false;
      state.connections = { connections: [], uploadTotal: 0, downloadTotal: 0 };
    }
    state.status = status;
    if (status.preparation?.active || !state.preparation?.active) state.preparation = status.preparation || state.preparation;
    if (state.preparation?.active) watchPreparation();
    renderSidebar(status);
    renderMetrics(status);
    renderQuickGroup();
    renderSubscriptions();
    updateConfigMeta();
    renderConfigDataHint();
    renderPreparation();
    renderSettingsForm(false);
    if (state.view === 'settings') renderCoreVersions();
    renderJob();
    handleJobTransition(status.job);
  } catch (error) {
    $('side-dot').className = 'dot error';
    $('side-state').textContent = '连接失败';
    $('side-core').textContent = error.message;
  }
}

/* --------------------------------------------------------------- prepare */

async function fetchPreparation() {
  try {
    const data = await get('preparation');
    return data?.preparation || null;
  } catch {
    return null;
  }
}

/** Poll quickly while a long first-run operation may be running. */
function watchPreparation(graceMs = 8000) {
  state.prepareWatchUntil = Math.max(state.prepareWatchUntil, Date.now() + graceMs);
  if (state.prepareTimer) return;
  state.prepareTimer = window.setInterval(async () => {
    const preparation = await fetchPreparation();
    if (preparation) {
      state.preparation = preparation;
      renderPreparation();
    }
    if (!state.preparation?.active && Date.now() > state.prepareWatchUntil) stopPreparationPolling();
  }, 900);
}

function stopPreparationPolling() {
  if (!state.prepareTimer) return;
  window.clearInterval(state.prepareTimer);
  state.prepareTimer = 0;
}

function applyPreparationCollapsed() {
  const button = $('prepare-toggle');
  const collapsed = state.prepareCollapsed === true;
  $('prepare-panel').classList.toggle('is-collapsed', collapsed);
  button.textContent = collapsed ? '+' : '–';
  button.title = collapsed ? '展开进度' : '收起进度';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function togglePreparation() {
  state.prepareCollapsed = !state.prepareCollapsed;
  applyPreparationCollapsed();
}

function renderPreparation() {
  const preparation = state.preparation;
  const panel = $('prepare-panel');
  if (!preparation?.active) {
    panel.hidden = true;
    return;
  }
  if (preparation.startedAt !== state.prepareStartedAt) {
    state.prepareStartedAt = preparation.startedAt;
    state.prepareCollapsed = false;
  }
  panel.hidden = false;
  applyPreparationCollapsed();
  $('prepare-title').textContent = preparation.label || '准备中';
  $('prepare-message').textContent = preparation.message || '正在处理…';
  $('prepare-elapsed').textContent = preparation.elapsedMs >= 1000 ? formatDuration(preparation.elapsedMs) : '刚刚开始';
  $('prepare-steps').replaceChildren(...(preparation.steps || []).map(step => {
    const item = node('li', step.label);
    if (step.state === 'active') item.className = 'is-active';
    else if (step.state === 'done') item.className = 'is-done';
    else if (step.state === 'error') item.className = 'is-error';
    return item;
  }));
  const bar = $('prepare-bar');
  if (preparation.bytesTotal > 0) {
    const percent = Math.min(100, Math.round((preparation.received / preparation.bytesTotal) * 100));
    bar.value = percent;
    $('prepare-bytes').textContent = `${formatBytes(preparation.received)} / ${formatBytes(preparation.bytesTotal)} · ${percent}%`;
  } else if (preparation.received > 0) {
    bar.removeAttribute('value');
    $('prepare-bytes').textContent = `已接收 ${formatBytes(preparation.received)}`;
  } else {
    bar.removeAttribute('value');
    $('prepare-bytes').textContent = '';
  }
}

/** A long operation may outlive the gateway timeout; keep the progress visible instead of a false error. */
async function reportLongActionError(fallbackMessage) {
  const preparation = await fetchPreparation();
  if (preparation?.active) {
    state.preparation = preparation;
    renderPreparation();
    watchPreparation();
    return notify('操作仍在后台进行，请查看进度浮窗，稍后再刷新状态', 'info', 7000);
  }
  notify(state.lastError || fallbackMessage, 'error', 6500);
}

/* --------------------------------------------------------------- proxies */

function proxySearch() {
  return ($('proxy-search').value || '').trim().toLowerCase();
}

function resolveProxyExit(name, seen = new Set()) {
  if (!name || seen.has(name) || seen.size > 5) return name || '';
  seen.add(name);
  const proxy = state.proxies?.proxies?.[name];
  return proxy?.now ? resolveProxyExit(proxy.now, seen) : name;
}

function chainText(group) {
  const exit = resolveProxyExit(group.now);
  const chain = [group.now, exit].filter((item, index, list) => item && list.indexOf(item) === index);
  return chain.length ? chain.join(' → ') : '未选择';
}

function nodeCard(name) {
  const detail = state.proxies?.proxies?.[name] || {};
  const card = node('div', '', 'node-card');
  const top = node('div', '', 'node-top');
  top.append(node('span', name, 'node-name'), node('span', delayText(detail.delay), `node-delay ${delayLevel(detail.delay)}`));
  const meta = node('div', '', 'node-meta');
  meta.append(node('span', detail.type || '节点'), node('span', detail.udp ? 'UDP' : 'TCP'));
  if (detail.alive === false) meta.append(node('span', '不可用', 'badge'));
  card.append(top, meta);
  return card;
}

function providerCard(provider, search) {
  const names = provider.proxies.filter(name => !search || name.toLowerCase().includes(search));
  if (!names.length && search && !provider.name.toLowerCase().includes(search)) return null;
  const card = node('div', '', 'provider-card');
  if (state.expandedProviders.has(provider.name)) card.classList.add('is-open');
  const head = node('div', '', 'provider-head');
  const main = node('div', '', 'provider-main');
  const icon = node('span', '', 'provider-icon');
  icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l18-7-7 18-2.5-7.5z"/></svg>';
  const label = node('div');
  label.append(node('div', provider.name, 'provider-name'), node('div', `${provider.type || '提供商'} · ${provider.count} 个节点`, 'provider-sub'));
  main.append(icon, label);
  const side = node('div', '', 'provider-side');
  const info = provider.subscriptionInfo || {};
  const infoValue = key => Number(info[key] ?? info[key[0].toUpperCase() + key.slice(1)]) || 0;
  const total = infoValue('total');
  const used = infoValue('download') + infoValue('upload');
  const expire = infoValue('expire');
  const stats = node('div', '', 'provider-stats');
  if (total > 0) {
    const bar = node('progress');
    bar.max = 100;
    bar.value = Math.min(100, Math.round(used / total * 100));
    stats.append(bar);
    stats.append(node('span', `${formatBytes(used)} / ${formatBytes(total)}`, 'provider-usage-text'));
  } else if (used > 0) {
    stats.append(node('span', `已用 ${formatBytes(used)} · 用量未知`, 'provider-usage-text'));
  } else {
    stats.append(node('span', '用量未知', 'provider-usage-text'));
  }
  stats.append(node('span', expire > 0 ? `到期 ${formatTime(expire * 1000)}` : '长期', 'provider-expiry'));
  side.append(stats);
  const actions = node('div', '', 'provider-actions');
  if (provider.canRefresh) {
    const refresh = button('刷新', { className: 'provider-refresh', title: '刷新该提供商的订阅内容' });
    refresh.addEventListener('click', async event => {
      event.stopPropagation();
      refresh.disabled = true;
      const result = await act(() => post('proxy/provider/refresh', { name: provider.name }), `已刷新 ${provider.name}`);
      refresh.disabled = false;
      if (result) setTimeout(() => refreshProxies(), 500);
    });
    actions.append(refresh);
  }
  actions.append(node('span', String(provider.count), 'provider-count'), node('span', '›', 'provider-chevron'));
  side.append(actions);
  head.append(main, side);
  const nodes = node('div', '', 'provider-nodes');
  const grid = node('div', '', 'node-grid');
  grid.append(...names.map(nodeCard));
  nodes.append(grid);
  head.addEventListener('click', () => {
    const open = !card.classList.contains('is-open');
    card.classList.toggle('is-open', open);
    if (open) state.expandedProviders.add(provider.name); else state.expandedProviders.delete(provider.name);
    updateToggleLabels();
  });
  card.append(head, nodes);
  return card;
}
function groupRow(group, search) {
  const optionNames = group.all.filter(name => !search || name.toLowerCase().includes(search) || group.name.toLowerCase().includes(search));
  if (!optionNames.length && !group.name.toLowerCase().includes(search)) return null;
  const row = node('div', '', 'group-row');
  if (group.now) row.classList.add('is-active');
  if (state.expandedGroups.has(group.name)) row.classList.add('is-open');
  const header = node('div', '', 'group-header');
  const groupIcon = node('span', '', 'group-icon');
  groupIcon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88" fill="currentColor" stroke="none"/></svg>';
  header.append(groupIcon);
  const main = node('div', '', 'group-main');
  main.append(node('div', group.name, 'group-title'), node('div', `${group.type} · ${chainText(group)}`, 'group-sub'));
  const side = node('div', '', 'group-side');
  const groupDelay = state.proxies?.proxies?.[group.name]?.delay;
  const delay = node('span', delayText(groupDelay), `node-delay ${delayLevel(groupDelay)}`);
  side.append(delay, node('span', `${group.all.length}`, 'group-count'), node('span', '›', 'group-chevron'));
  header.append(main, side);
  const options = node('div', '', 'group-options');
  const grid = node('div', '', 'node-grid');
  for (const name of optionNames) {
    const detail = state.proxies?.proxies?.[name] || {};
    const card = node('button', '', 'node-card');
    card.type = 'button';
    if (name === group.now) card.classList.add('is-active');
    card.disabled = group.type !== 'Selector';
    const top = node('div', '', 'node-top');
    top.append(node('span', name, 'node-name'), node('span', delayText(detail.delay), `node-delay ${delayLevel(detail.delay)}`));
    const meta = node('div', '', 'node-meta');
    meta.append(node('span', detail.type || '节点'), node('span', detail.udp ? 'UDP' : 'TCP'));
    card.append(top, meta);
    if (group.type === 'Selector') {
      card.addEventListener('click', async () => {
        const result = await act(() => post('proxy/select', { group: group.name, name }), `已将 ${group.name} 切换到 ${name}`);
        if (result) refreshProxies();
      });
    }
    grid.append(card);
  }
  options.append(grid);
  header.addEventListener('click', () => {
    const open = !row.classList.contains('is-open');
    row.classList.toggle('is-open', open);
    if (open) state.expandedGroups.add(group.name); else state.expandedGroups.delete(group.name);
    updateToggleLabels();
  });
  row.append(header, options);
  return row;
}

function updateToggleLabels() {
  const providers = state.proxies?.providers || [];
  const groups = visibleGroups();
  $('toggle-providers').textContent = providers.length && providers.every(provider => state.expandedProviders.has(provider.name)) ? '全部收起' : '全部展开';
  $('toggle-groups').textContent = groups.length && groups.every(group => state.expandedGroups.has(group.name)) ? '全部收起' : '全部展开';
}

function visibleGroups() {
  const mode = state.status?.core.mode || 'rule';
  let groups = (state.proxies?.groups || []).filter(group => !group.hidden);
  if (mode !== 'global') groups = groups.filter(group => group.name !== 'GLOBAL');
  else groups = [...groups].sort((left, right) => (left.name === 'GLOBAL' ? -1 : right.name === 'GLOBAL' ? 1 : 0));
  return groups;
}

function renderProxies() {
  const running = state.status?.core.running === true;
  const data = state.proxies;
  const mode = state.status?.core.mode || 'rule';
  const groups = visibleGroups();
  const providers = data?.providers || [];
  const localNodes = data?.local?.proxies || [];
  const search = proxySearch();
  const hint = $('proxy-mode-hint');

  $('proxy-summary').textContent = data
    ? `${providers.length} 个提供商 · ${providers.reduce((sum, item) => sum + item.count, 0) + localNodes.length} 个节点 · ${groups.length} 个策略组`
    : '—';
  $('delay-all').disabled = !running;
  $('toggle-providers').disabled = !providers.length;
  $('toggle-groups').disabled = !groups.length;

  if (mode === 'global') {
    const global = groups.find(group => group.name === 'GLOBAL');
    const exit = resolveProxyExit(global?.now);
    const direct = !exit || ['DIRECT', 'REJECT'].includes(exit);
    hint.hidden = false;
    hint.className = `mode-hint${direct ? ' warn' : ''}`;
    hint.textContent = direct
      ? `全局模式实际出口为 ${exit || '未选择'}${global?.now && global.now !== exit ? `（GLOBAL → ${global.now}）` : ''}，访问外网不会经过代理节点。请在 GLOBAL 策略组中选择节点。`
      : `全局模式下全部流量经 GLOBAL 出口 ${exit}${global?.now && global.now !== exit ? `（GLOBAL → ${global.now}）` : ''}。`;
  } else if (mode === 'direct') {
    hint.hidden = false;
    hint.className = 'mode-hint warn';
    hint.textContent = '直连模式下全部流量直连，不使用代理节点。';
  } else hint.hidden = true;

  if (!data) {
    $('local-nodes-card').hidden = true;
    $('node-providers').replaceChildren(node('p', running ? '正在读取节点…' : 'Core 运行后加载节点', 'empty'));
    $('group-list').replaceChildren(node('p', running ? '正在读取策略组…' : 'Core 运行后加载策略组', 'empty'));
    return;
  }

  const providerNodes = providers.map(provider => providerCard(provider, search)).filter(Boolean);
  const providerEmpty = localNodes.length
    ? '配置未使用 proxy-providers，节点见下方「配置节点」'
    : '配置中未定义 proxy-providers';
  $('node-providers').replaceChildren(...(providerNodes.length ? providerNodes : [node('p', search ? '没有匹配的提供商' : providerEmpty, 'empty')]));

  $('local-nodes-card').hidden = localNodes.length === 0;
  $('local-nodes-count').textContent = `${localNodes.length} 个节点`;
  $('toggle-local-nodes').textContent = state.localNodesOpen ? '收起' : '展开';
  if (state.localNodesOpen) {
    const matchedLocal = localNodes.filter(name => !search || name.toLowerCase().includes(search));
    $('local-node-grid').hidden = false;
    $('local-node-grid').replaceChildren(...(matchedLocal.length ? matchedLocal.map(nodeCard) : [node('p', '没有匹配的节点', 'empty')]));
  } else {
    $('local-node-grid').hidden = true;
    $('local-node-grid').replaceChildren();
  }

  const groupRows = groups.map(group => groupRow(group, search)).filter(Boolean);
  const groupEmpty = localNodes.length
    ? '配置中没有策略组；可切换到「全局」模式，在 GLOBAL 组中选择节点，或参考「载入模板」补充分组'
    : '配置中没有策略组';
  $('group-list').replaceChildren(...(groupRows.length ? groupRows : [node('p', search ? '没有匹配的策略组' : groupEmpty, 'empty')]));
  updateToggleLabels();
}

async function refreshProxies() {
  if (state.status?.core.running !== true) {
    state.proxies = null;
    renderProxies();
    return;
  }
  try {
    state.proxies = await get('proxies');
    state.initializedProxies = true;
    renderProxies();
    renderQuickGroup();
  } catch (error) {
    if (state.view === 'proxies') notify(error.message, 'error');
  }
}

function wireProxies() {
  $('proxy-search').addEventListener('input', () => renderProxies());
  $('toggle-local-nodes').addEventListener('click', () => {
    state.localNodesOpen = !state.localNodesOpen;
    renderProxies();
  });
  $('toggle-providers').addEventListener('click', () => {
    const providers = state.proxies?.providers || [];
    const allOpen = providers.length && providers.every(provider => state.expandedProviders.has(provider.name));
    for (const provider of providers) {
      if (allOpen) state.expandedProviders.delete(provider.name); else state.expandedProviders.add(provider.name);
    }
    renderProxies();
  });
  $('toggle-groups').addEventListener('click', () => {
    const groups = visibleGroups();
    const allOpen = groups.length && groups.every(group => state.expandedGroups.has(group.name));
    for (const group of groups) {
      if (allOpen) state.expandedGroups.delete(group.name); else state.expandedGroups.add(group.name);
    }
    renderProxies();
  });
  $('delay-all').addEventListener('click', () => runDelayAll($('delay-all')));
  $('quick-delay').addEventListener('click', () => runDelayAll($('quick-delay')));
}

async function runDelayAll(sourceButton) {
  sourceButton.disabled = true;
  const label = sourceButton.textContent;
  sourceButton.textContent = '测速中…';
  const result = await act(() => post('proxy/delay-all'), '', { silent: true });
  sourceButton.textContent = label;
  sourceButton.disabled = false;
  if (result) {
    for (const [groupName, delays] of Object.entries(result.groups || {})) {
      if (!delays || delays.error) continue;
      for (const [name, delay] of Object.entries(delays)) {
        const value = Number(delay);
        if (value > 0 && state.proxies?.proxies?.[name]) state.proxies.proxies[name].delay = value;
      }
      const group = state.proxies?.groups?.find(item => item.name === groupName);
      const selected = group ? state.proxies?.proxies?.[group.now] : null;
      if (selected?.delay > 0 && state.proxies?.proxies?.[groupName]) state.proxies.proxies[groupName].delay = selected.delay;
    }
    renderProxies();
    renderQuickGroup();
    notify(`已测速 ${Object.keys(result.groups || {}).length} 个策略组，${result.tested || 0} 个节点结果`, 'success', 5000);
    refreshProxies();
  }
}

/* ------------------------------------------------------------- connections */

let connVirtual = null;

function connectionRow(item) {
  const row = node('div', '', 'conn-row');
  row.append(
    node('span', formatClock(item.start), 'conn-cell'),
    node('span', item.network || '—', 'conn-cell'),
    node('span', truncate(item.host || '—', 30), 'conn-cell'),
    node('span', connectionTarget(item), 'conn-cell'),
    node('span', truncate((item.chains || []).join(' → ') || '—', 28), 'conn-cell'),
    node('span', truncate(item.rule || '—', 24), 'conn-cell'),
    node('span', formatBytes(item.upload), 'conn-cell'),
    node('span', formatBytes(item.download), 'conn-cell'),
  );
  row.addEventListener('click', () => openConnectionDetail(item));
  return row;
}

function openConnectionDetail(item) {
  state.currentConnection = item;
  const fields = [
    ['开始时间', item.start ? `${formatTime(item.start)} ${formatClock(item.start)}` : '—'],
    ['网络 / 类型', `${item.network || '—'} / ${item.type || '—'}`],
    ['主机', item.host || '—'],
    ['来源', item.source || '—'],
    ['目标', connectionTarget(item)],
    ['目标 IP', item.destination || '—'],
    ['链路', (item.chains || []).join(' → ') || '—'],
    ['规则', `${item.rule || '—'}${item.rulePayload ? `（${item.rulePayload}）` : ''}`],
    ['进程', item.process || '—'],
    ['上传 / 下载', `${formatBytes(item.upload)} / ${formatBytes(item.download)}`],
  ];
  const list = $('connection-detail');
  list.replaceChildren(...fields.flatMap(([key, value]) => [node('dt', key), node('dd', value)]));
  $('connection-dialog').showModal();
}

function renderConnections() {
  const data = state.connections || { connections: [] };
  const search = ($('conn-filter').value || '').trim().toLowerCase();
  const items = data.connections.filter(item => !search || [item.host, item.destination, item.rule, item.rulePayload, ...(item.chains || [])].join(' ').toLowerCase().includes(search));
  $('conn-summary').textContent = `${items.length} 个连接 · 下载 ${formatBytes(data.downloadTotal)} · 上传 ${formatBytes(data.uploadTotal)}`;
  $('conn-empty').hidden = items.length > 0;
  connVirtual.setItems(items);
}

async function refreshConnections() {
  if (state.status?.core.running !== true) {
    state.connections = { connections: [], uploadTotal: 0, downloadTotal: 0 };
    renderConnections();
    return;
  }
  try {
    state.connections = await get('connections');
    renderConnections();
  } catch (error) {
    if (state.view === 'connections') notify(error.message, 'error');
  }
}

function wireConnections() {
  $('conn-filter').addEventListener('input', () => renderConnections());
  $('conn-refresh').addEventListener('click', async () => {
    await refreshConnections();
    notify('已刷新连接列表', 'success', 2000);
  });
  $('close-all').addEventListener('click', async () => {
    if (!(await askConfirm('关闭全部连接', '将断开当前所有活动连接，代理规则本身不会改变。'))) return;
    const result = await act(() => post('connection/close-all'), '已关闭全部连接');
    if (result) refreshConnections();
  });
  $('connection-close').addEventListener('click', async () => {
    const item = state.currentConnection;
    if (!item) return;
    const result = await act(() => post('connection/close', { id: item.id }), '连接已关闭');
    if (result) {
      $('connection-dialog').close();
      refreshConnections();
    }
  });
}

/* ------------------------------------------------------------------ config */

function updateConfigMeta() {
  const config = state.status?.config;
  if (!config) return;
  $('config-meta').textContent = `${configKindLabel(config.kind)} · ${formatTime(config.updatedAt)} · ${formatBytes(config.size)}`;
}

function renderConfigDataHint() {
  const readiness = state.status?.readiness;
  const hint = $('config-data-hint');
  if (!readiness || readiness.ready !== false) { hint.hidden = true; return; }
  const names = (readiness.names || []).join('、') || '外部数据';
  hint.hidden = false;
  hint.textContent = `首次应用或校验配置会自动下载 ${names}，根据网络可能需要数分钟；进度浮窗会显示下载进度，期间请勿关闭页面。`;
}

function backupLabel(label) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(String(label));
  return match ? `${match[1]} ${match[2]}:${match[3]}:${match[4]}` : String(label);
}

async function loadBackups() {
  try {
    const data = await get('backups');
    const select = $('backup-select');
    const current = select.value;
    select.replaceChildren(node('option', '选择备份…'));
    select.firstChild.value = '';
    select.firstChild.disabled = true;
    for (const item of data.backups) {
      const option = node('option', `${backupLabel(item.label)} · ${formatBytes(item.size)}`);
      option.value = item.id;
      select.append(option);
    }
    if ([...select.options].some(option => option.value === current)) select.value = current;
  } catch { /* backup list is optional */ }
}

function renderManagedHint(managed) {
  $('config-managed-hint').hidden = !managed?.length;
  $('config-managed-hint').textContent = managed?.length ? `由系统接管：${managed.join('、')}。` : '';
}

async function ensureConfig(force = false) {
  if (state.configLoaded && !force) return;
  try {
    const data = await get('config');
    $('config-source').value = data.source;
    $('config-meta').textContent = `${configKindLabel(data.kind)} · ${formatTime(data.updatedAt)} · ${formatBytes(data.size ?? data.source.length)}`;
    renderManagedHint(data.managedKeys);
    state.configLoaded = true;
    state.configDirty = false;
    await loadBackups();
  } catch (error) {
    notify(error.message, 'error');
  }
}

function wireConfig() {
  $('config-source').addEventListener('input', () => { state.configDirty = true; });
  $('load-template-config').addEventListener('click', async () => {
    if (state.configDirty && !(await askConfirm('载入默认模板', '当前编辑内容会被默认模板替换（不会立即保存）。'))) return;
    const data = await act(() => get('config/template'), '', { silent: true });
    if (!data) return notify(state.lastError || '读取默认模板失败', 'error', 6000);
    $('config-source').value = data.source;
    state.configDirty = true;
    state.configLoaded = true;
    notify('已载入默认模板：在 proxy-providers 中填入订阅链接后保存并应用', 'info', 7000);
  });
  $('import-config-button').addEventListener('click', () => $('import-config').click());
  $('import-config').addEventListener('change', async () => {
    const file = $('import-config').files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { notify('配置文件超过 2 MiB 限制', 'error'); $('import-config').value = ''; return; }
    try {
      const text = await file.text();
      if (!text.trim()) return notify('文件内容为空', 'warning');
      $('config-source').value = text;
      state.configDirty = true;
      notify(`已载入 ${file.name}，保存前会自动校验`, 'info');
    } catch (error) {
      notify(`读取文件失败：${error.message}`, 'error');
    } finally {
      $('import-config').value = '';
    }
  });
  $('save-config').addEventListener('click', async () => {
    const source = $('config-source').value;
    if (!source.trim()) return notify('配置内容不能为空', 'warning');
    if (/url:\s*""/.test(source)) {
      const replace = await askConfirm('订阅链接尚未填入', '配置中的订阅链接还是空的，保存后不会有代理节点。仍要保存吗？');
      if (!replace) return;
    }
    const buttonEl = $('save-config');
    buttonEl.disabled = true;
    buttonEl.textContent = '准备并应用中…';
    watchPreparation();
    const result = await act(() => post('config/save', { source }), '', { silent: true });
    buttonEl.disabled = false;
    buttonEl.textContent = '保存并应用';
    if (!result) return reportLongActionError('配置应用失败');
    if (result.configSaved === false) notify('配置无变化，未保存', 'info');
    else notify('配置已校验、保存并应用', 'success');
    state.configLoaded = false;
    state.configDirty = false;
    await ensureConfig(true);
    await refreshStatus();
    if (state.view === 'proxies') refreshProxies();
  });
  $('validate-config').addEventListener('click', async () => {
    const buttonEl = $('validate-config');
    buttonEl.disabled = true;
    watchPreparation();
    const result = await act(() => post('config/validate', { source: $('config-source').value }), '', { silent: true });
    buttonEl.disabled = false;
    if (!result) return reportLongActionError('配置校验失败');
    const info = result.info || {};
    const ports = Object.entries(info.ports || {}).map(([name, port]) => `${name}:${port}`).join('，') || '未配置端口';
    notify(`配置校验通过（${ports}）`, 'success', 5000);
  });
  $('refresh-config').addEventListener('click', async () => {
    if (state.configDirty && !(await askConfirm('重新载入配置', '当前编辑内容尚未保存，重新载入会丢弃这些修改。'))) return;
    await ensureConfig(true);
  });
  $('restore-backup').addEventListener('click', async () => {
    const id = $('backup-select').value;
    if (!id) return notify('请选择一个备份', 'warning');
    if (!(await askConfirm('恢复配置备份', '将使用所选备份替换当前配置，并重启内核。'))) return;
    watchPreparation();
    const result = await act(() => post('config/restore', { id }), '配置已从备份恢复');
    if (result) {
      state.configLoaded = false;
      await ensureConfig(true);
      await refreshStatus();
    }
  });
  $('delete-backup').addEventListener('click', async () => {
    const id = $('backup-select').value;
    if (!id) return notify('请选择一个备份', 'warning');
    if (!(await askConfirm('删除配置备份', '将永久删除所选备份文件。'))) return;
    const result = await act(() => post('config/backup/delete', { id }), '备份已删除');
    if (result) await loadBackups();
  });
}

/* ------------------------------------------------------------ subscriptions */

function renderSubscriptions() {
  const list = $('subscription-list');
  const subscriptions = state.status?.subscriptions || [];
  if (!subscriptions.length) {
    list.replaceChildren(node('p', '尚未添加订阅，可新增订阅或直接在下方编辑配置。', 'empty'));
    return;
  }
  list.replaceChildren(...subscriptions.map(item => {
    const card = node('div', '', 'subscription-card');
    const head = node('div', '', 'subscription-head');
    const title = node('div', '', 'subscription-title');
    title.append(node('strong', item.name));
    if (item.applied) title.append(node('span', '当前配置', 'badge good'));
    const actions = node('div', '', 'subscription-actions');
    actions.append(
      button('更新', { onClick: () => runSubscriptionAction('subscription/update', item.id, '订阅已更新') }),
      button('应用', { className: 'primary', onClick: async () => {
        if (!(await askConfirm('应用订阅配置', `将使用订阅「${item.name}」替换当前配置，并重启内核。`))) return;
        await runSubscriptionAction('subscription/apply', item.id, '订阅配置已应用', true);
      } }),
      button('编辑', { onClick: () => openSubscriptionDialog(item) }),
      button('删除', { className: 'danger', onClick: async () => {
        if (!(await askConfirm('删除订阅', `将删除订阅「${item.name}」及其本地缓存内容。`))) return;
        const result = await act(() => post('subscription/delete', { id: item.id }), '订阅已删除');
        if (result) refreshStatus();
      } }),
    );
    head.append(title, actions);
    const url = node('div', item.urlMasked, 'subscription-url');
    url.title = item.urlMasked;
    const meta = node('div', '', 'subscription-meta');
    meta.append(
      node('span', item.updatedAt ? `更新于 ${formatTime(item.updatedAt)}` : '尚未下载'),
      node('span', item.intervalHours > 0 ? `每 ${item.intervalHours} 小时自动更新` : '不自动更新'),
      node('span', formatBytes(item.size)),
    );
    card.append(head, url, meta);
    if (item.lastError) card.append(node('p', item.lastError, 'subscription-error'));
    return card;
  }));
}

async function runSubscriptionAction(action, id, message, reloadConfig = false) {
  const buttonEls = [...document.querySelectorAll('.subscription-actions button')];
  for (const item of buttonEls) item.disabled = true;
  if (reloadConfig) watchPreparation();
  const result = await act(() => post(action, { id }), message);
  for (const item of buttonEls) item.disabled = false;
  if (result) {
    if (result.augmented?.length) notify('订阅未包含策略组或规则，已自动补充「节点选择 / 自动选择」和基础规则', 'warning', 9000);
    await refreshStatus();
    if (reloadConfig) { state.configLoaded = false; await ensureConfig(true); }
  }
}

function openSubscriptionDialog(item = null) {
  state.editingSubscription = item?.id || '';
  $('subscription-title').textContent = item ? '编辑订阅' : '新增订阅';
  $('sub-name').value = item?.name || '';
  $('sub-url').value = '';
  $('sub-url').placeholder = item ? '留空保持原订阅地址' : 'https://example.com/subscribe?token=…';
  $('sub-interval').value = String(item?.intervalHours ?? 24);
  $('subscription-dialog').showModal();
  $('sub-name').focus();
}

function wireSubscriptions() {
  $('add-subscription').addEventListener('click', () => openSubscriptionDialog());
  $('save-subscription').addEventListener('click', async () => {
    const name = $('sub-name').value.trim();
    const url = $('sub-url').value.trim();
    const intervalHours = Number($('sub-interval').value || 0);
    if (!name) return notify('请填写订阅名称', 'warning');
    if (!state.editingSubscription && !url) return notify('请填写订阅地址', 'warning');
    const body = { name, intervalHours };
    if (url) body.url = url;
    const result = await act(() => state.editingSubscription
      ? post('subscription/settings', { id: state.editingSubscription, ...body })
      : post('subscription/add', body), state.editingSubscription ? '订阅已更新' : '订阅已添加');
    if (result) {
      $('subscription-dialog').close();
      await refreshStatus();
    }
  });
}

/* -------------------------------------------------------------------- logs */

let logVirtual = null;

function filteredLogs() {
  const level = $('log-level').value;
  const floor = Object.hasOwn(LOG_LEVELS, level) ? LOG_LEVELS[level] : -1;
  const search = ($('log-search').value || '').trim().toLowerCase();
  return state.logs.filter(entry =>
    (floor < 0 || (LOG_LEVELS[entry.level] ?? 1) >= floor) &&
    (!search || `${entry.message} ${entry.source}`.toLowerCase().includes(search)));
}

function logRow(entry) {
  const row = node('div', '', 'log-row');
  row.append(
    node('time', formatClock(entry.at)),
    node('span', levelLabel(entry.level), `log-level ${entry.level}`),
    node('span', entry.source, 'log-source'),
    node('span', entry.message, 'log-message'),
  );
  row.title = `${entry.at} ${entry.message}`;
  return row;
}

function renderLogs() {
  const entries = filteredLogs();
  $('log-empty').hidden = entries.length > 0;
  logVirtual.setItems(entries);
  if ($('log-follow').checked) {
    const viewport = $('log-list').querySelector('.virtual-viewport');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }
}

function scheduleLogRender() {
  if (state.logTimer) return;
  state.logTimer = window.setTimeout(() => {
    state.logTimer = 0;
    if (state.view === 'logs') renderLogs();
  }, 120);
}

function wireLogs() {
  $('log-level').addEventListener('change', renderLogs);
  $('log-search').addEventListener('input', renderLogs);
  $('log-clear').addEventListener('click', () => { state.logs = []; renderLogs(); });
}

/* ---------------------------------------------------------------- settings */

function coreTypeLabel(item) {
  if (item?.typeLabel) return item.typeLabel;
  if (item?.channel === 'smart') return 'Smart版';
  if (item?.channel === 'metacubex-test') return '测试版';
  return '稳定版';
}

function renderSettingsForm(force = false) {
  const status = state.status;
  if (!status) return;
  if (force || !state.settingsDirty) {
    $('set-autostart').checked = status.settings.autoStart;
    $('set-autorestart').checked = status.settings.autoRestart;
    $('set-allow-lan').checked = status.settings.allowLan === true;
    $('set-mixed-port').value = String(status.settings.mixedPort || 7890);
    $('set-http-port').value = String(status.settings.httpPort || 0);
    $('set-socks-port').value = String(status.settings.socksPort || 0);
    $('set-delay-interval').value = String(status.settings.delayIntervalMinutes ?? 30);
    $('set-delay-url').value = status.settings.delayTestUrl || 'https://www.gstatic.com/generate_204';
    $('set-delay-concurrency').value = String(status.settings.delayConcurrency || 5);
    $('set-unified-delay').checked = status.settings.unifiedDelay !== false;
    $('set-tcp-concurrent').checked = status.settings.tcpConcurrent !== false;
    $('set-github-mirror').value = status.settings.githubMirror ?? 'https://ghfast.top/';
    $('set-ua-prefix').textContent = status.settings.userAgentPrefix || '—';
    $('set-ua-suffix').value = status.settings.userAgentSuffix ?? 'clash.meta; clash';
    $('set-loglevel').value = status.settings.logLevel;
    const channels = status.versions.channels || [];
    const select = $('set-channel');
    if (select.options.length !== channels.length) {
      select.replaceChildren(...channels.map(item => {
        const option = node('option', item.label);
        option.value = item.id;
        return option;
      }));
    }
    select.value = status.settings.channel;
  }
  renderCoreVersions();
  renderJob();
}

async function refreshData() {
  const data = await act(() => get('data'), '', { silent: true });
  if (!data) return;
  state.data = data;
  renderData();
}

function renderData() {
  const data = state.data;
  if (!data) return;
  $('set-data-auto').checked = data.settings.autoUpdate === true;
  $('set-data-interval').value = String(data.settings.intervalHours || 24);
  const model = $('set-data-model');
  if (model.options.length !== data.settings.modelOptions.length) {
    model.replaceChildren(...data.settings.modelOptions.map(item => {
      const option = node('option', item.label);
      option.value = item.id;
      option.dataset.url = item.url || '';
      return option;
    }));
  }
  model.value = data.settings.model;
  const list = $('data-list');
  list.replaceChildren(...data.items.map(item => {
    const row = node('div', '', 'data-row');
    const main = node('div', '', 'data-row-main');
    const title = node('div', '', 'data-row-title');
    title.append(node('strong', item.name), node('span', item.filename, 'muted'));
    main.append(title, node('div', `${item.exists ? `${formatBytes(item.size)} · ${formatTime(item.updatedAt)}` : '尚未下载'}${item.model ? ' · Smart 专用' : ''}`, 'data-row-meta'));
    const input = node('input');
    input.type = 'url';
    input.value = item.url;
    input.dataset.dataKey = item.key;
    input.setAttribute('aria-label', `${item.name} 更新地址`);
    const actions = node('div', '', 'data-row-actions');
    const sync = node('button', '立即同步');
    sync.type = 'button';
    sync.addEventListener('click', async () => {
      sync.disabled = true;
      sync.textContent = '同步中…';
      watchPreparation();
      const result = await act(() => post('data/sync', { key: item.key, url: input.value.trim() }), `${item.name} 已同步`);
      sync.disabled = false;
      sync.textContent = '立即同步';
      if (result) { await refreshData(); await refreshStatus(); }
    });
    actions.append(sync);
    row.append(main, actions, input);
    return row;
  }));
}

function renderJob() {
  const job = state.status?.job;
  const progress = $('job-progress');
  if (!job || job.state !== 'running') { progress.hidden = true; return; }
  progress.hidden = false;
  $('job-message').textContent = job.message || '处理中';
  if (job.total > 0 && job.message?.includes('下载')) {
    $('job-bar').value = Math.min(100, Math.round((job.received / job.total) * 100));
    $('job-size').textContent = `${formatBytes(job.received)} / ${formatBytes(job.total)}`;
  } else {
    $('job-bar').removeAttribute('value');
    $('job-size').textContent = '';
  }
}

function versionRow({ title, subtitle, tags = [], actions = [] }) {
  const row = node('div', '', 'version-row');
  const copy = node('div', '', 'version-copy');
  copy.append(node('strong', title), node('small', subtitle, 'muted'));
  if (tags.length) {
    const tagWrap = node('div', '', 'version-tags');
    for (const [text, kind] of tags) tagWrap.append(node('span', text, `badge${kind ? ` ${kind}` : ''}`));
    copy.append(tagWrap);
  }
  const actionWrap = node('div', '', 'version-actions');
  actionWrap.append(...actions);
  row.append(copy, actionWrap);
  return row;
}

function renderCoreVersions() {
  const status = state.status;
  if (!status) return;
  const versions = status.versions;
  const archLabel = versions.supportedArch === 'x86_64' ? 'x86_64' : versions.supportedArch === 'arm64' ? 'ARM64' : versions.supportedArch || '未知';
  $('core-arch').textContent = `设备架构 ${archLabel}${status.platform.supported ? '' : ' · 本机预览模式，无法启动 Linux 内核'}`;
  const busy = status.job.state === 'running';
  $('rollback-core').disabled = busy || !versions.previousId || versions.previousId === versions.activeId;
  $('check-core').disabled = busy;
  const installed = versions.installed || [];
  $('core-versions').replaceChildren(...(installed.length ? installed.map(item => versionRow({
    title: item.invalid ? item.id : `${coreTypeLabel(item)} ${item.version}`,
    subtitle: item.invalid ? '版本记录异常，请删除后重新安装' : `${item.arch} · ${formatBytes(item.size)}`,
    tags: [item.active ? ['当前使用', 'good'] : null, item.id === versions.previousId ? ['上一版本'] : null].filter(Boolean),
    actions: item.active ? [] : [
      ...(item.invalid ? [] : [button('启用', { disabled: busy, onClick: () => confirmCoreAction('activate', item) })]),
      button('删除', { className: 'danger', disabled: busy, onClick: () => confirmCoreAction('remove', item) }),
    ],
  })) : [node('p', '尚未安装其他内核版本', 'empty')]));
  $('core-embedded').replaceChildren(...(versions.embedded || []).map(item => versionRow({
    title: `${coreTypeLabel(item)} ${item.version}`,
    subtitle: `应用内置 · ${item.arch}`,
    tags: [item.active ? ['当前使用', 'good'] : null].filter(Boolean),
    actions: item.active ? [] : [button('启用', { disabled: busy, onClick: () => confirmCoreAction('activate', item) })],
  })));
  const channels = Object.fromEntries((versions.channels || []).map(item => [item.id, item]));
  $('available-channel').textContent = versions.availableChannel ? channels[versions.availableChannel]?.label || versions.availableChannel : '';
  const available = (versions.available || []).filter(item => item.arch === versions.supportedArch);
  if (versions.availableError) $('available-hint').textContent = versions.availableError;
  else if (!available.length) $('available-hint').textContent = '';
  else if (versions.availableFallback) $('available-hint').textContent = 'GitHub API 受限，已使用备用来源；安装时下载后计算 SHA256 并校验架构与版本。';
  else $('available-hint').textContent = `共 ${available.length} 个可用版本，安装后需手动启用。`;
  $('core-available').replaceChildren(...available.map(item => versionRow({
    title: item.version || `${item.build || '测试构建'}`,
    subtitle: `${item.channelLabel} · ${item.arch} · ${formatBytes(item.size)} · ${formatTime(item.publishedAt)}`,
    tags: [item.verified ? ['SHA256 已锁定', 'good'] : ['备用来源 · 下载后校验', 'warn']].concat(item.risk ? [['风险渠道', 'warn']] : []),
    actions: [button('安装', { className: 'primary', disabled: busy || installed.some(entry => entry.id === item.id), onClick: () => confirmCoreAction('install', item) })],
  })));
}

async function confirmCoreAction(action, item) {
  if (action === 'rollback') {
    if (!(await askConfirm('回滚内核', '将切换到上一版本并重启内核；若启动失败会自动恢复当前版本。'))) return;
  } else {
    const id = item.id;
    const label = item.version || item.build || id;
    const labels = {
      install: ['安装内核', `将下载 ${label}（${item.arch}），${item.verified ? '校验 SHA256、' : '下载后计算 SHA256，并校验'}架构和版本后安装，不会自动启用。`],
      activate: ['启用内核', `将切换到 ${label} 并重启内核；若启动失败会自动恢复原版本。`],
      remove: ['删除内核', `将删除 ${label} 的本地文件。`],
    };
    if (!(await askConfirm(labels[action][0], labels[action][1]))) return;
  }
  const result = await act(() => post(`core/${action}`, action === 'rollback' ? {} : { id: item.id }), '', { silent: true });
  if (result) { await refreshStatus(); renderSettingsForm(true); }
}

function wireSettings() {
  for (const element of [$('set-autostart'), $('set-autorestart'), $('set-allow-lan'), $('set-mixed-port'), $('set-http-port'), $('set-socks-port'), $('set-delay-interval'), $('set-delay-url'), $('set-delay-concurrency'), $('set-unified-delay'), $('set-tcp-concurrent'), $('set-github-mirror'), $('set-ua-suffix'), $('set-loglevel'), $('set-channel')]) {
    const event = ['number', 'text', 'url'].includes(element.type) ? 'input' : 'change';
    element.addEventListener(event, () => { state.settingsDirty = true; });
  }
  $('save-settings').addEventListener('click', async () => {
    const result = await privilegedAct(async password => post('settings/save', {
      autoStart: $('set-autostart').checked,
      autoRestart: $('set-autorestart').checked,
      allowLan: $('set-allow-lan').checked,
      mixedPort: Number($('set-mixed-port').value || 0),
      httpPort: Number($('set-http-port').value || 0),
      socksPort: Number($('set-socks-port').value || 0),
      logLevel: $('set-loglevel').value,
      channel: $('set-channel').value,
      delayIntervalMinutes: Number($('set-delay-interval').value || 0),
      delayTestUrl: $('set-delay-url').value.trim(),
      delayConcurrency: Number($('set-delay-concurrency').value || 5),
      unifiedDelay: $('set-unified-delay').checked,
      tcpConcurrent: $('set-tcp-concurrent').checked,
      githubMirror: $('set-github-mirror').value.trim(),
      userAgentSuffix: $('set-ua-suffix').value.trim(),
      password,
    }), '设置已保存');
    if (result) { state.settingsDirty = false; await refreshStatus(); renderSettingsForm(true); }
  });
  $('set-data-model').addEventListener('change', () => {
    const selected = $('set-data-model').selectedOptions[0];
    const input = document.querySelector('#data-list input[data-data-key="model"]');
    if (input && selected?.dataset.url) input.value = selected.dataset.url;
  });
  $('save-data-settings').addEventListener('click', async () => {
    const urls = {};
    for (const input of document.querySelectorAll('#data-list input[data-data-key]')) urls[input.dataset.dataKey] = input.value.trim();
    const result = await act(() => post('data/save', {
      autoUpdate: $('set-data-auto').checked,
      intervalHours: Number($('set-data-interval').value || 24),
      model: $('set-data-model').value,
      urls,
    }), '数据设置已保存');
    if (result) { state.data = result; renderData(); }
  });
  $('sync-all-data').addEventListener('click', async () => {
    const button = $('sync-all-data');
    button.disabled = true;
    button.textContent = '同步中…';
    watchPreparation();
    const result = await act(() => post('data/sync-all', {}), '外部数据已全部同步');
    button.disabled = false;
    button.textContent = '全部立即同步';
    if (result) { await refreshData(); await refreshStatus(); }
  });
  $('check-core').addEventListener('click', async () => {
    const channel = $('set-channel').value;
    const buttonEl = $('check-core');
    buttonEl.disabled = true;
    buttonEl.textContent = '检查中…';
    const result = await act(async () => {
      if (state.status?.settings?.channel !== channel) {
        await post('settings/save', {
          autoStart: $('set-autostart').checked,
          autoRestart: $('set-autorestart').checked,
          allowLan: $('set-allow-lan').checked,
          mixedPort: Number($('set-mixed-port').value || 0),
          httpPort: Number($('set-http-port').value || 0),
          socksPort: Number($('set-socks-port').value || 0),
          logLevel: $('set-loglevel').value,
          channel,
          delayIntervalMinutes: Number($('set-delay-interval').value || 0),
          delayTestUrl: $('set-delay-url').value.trim(),
          delayConcurrency: Number($('set-delay-concurrency').value || 5),
          unifiedDelay: $('set-unified-delay').checked,
          tcpConcurrent: $('set-tcp-concurrent').checked,
          githubMirror: $('set-github-mirror').value.trim(),
          userAgentSuffix: $('set-ua-suffix').value.trim(),
          password,
        });
        state.settingsDirty = false;
      }
      return post('core/check', { channel });
    }, '已获取可用内核版本');
    buttonEl.disabled = false;
    buttonEl.textContent = '检查版本';
    await refreshStatus();
    if (result) renderCoreVersions();
  });
  $('rollback-core').addEventListener('click', () => confirmCoreAction('rollback'));
  $('run-diagnostics').addEventListener('click', async () => {
    const data = await act(() => get('diagnostics'), '', { silent: true });
    if (!data) return;
    const lines = [
      `应用版本：${data.app?.version || '—'}`,
      `User-Agent：${data.userAgent || '—'}`,
      `内核：${data.core?.running ? `运行中 ${data.core.version || ''}` : '未运行'}（${data.core?.activeId || '未选择版本'}）`,
      `Core 路径：${data.core?.path || '—'}`,
      `Core 挂载：${data.core?.mountOptions || '未知'}`,
      `增强模式：${data.tun?.active ? `已生效（TUN 网卡 ${data.tun.device}）` : data.tun?.configured ? `未生效（${data.tun.message || '未发现 TUN 网卡'}）` : '未开启'}`,
      `TUN 前置条件：/dev/net/tun ${data.tun?.devicePresent ? '存在' : '缺失'} · CAP_NET_ADMIN ${data.tun?.capNetAdmin === true ? '有' : data.tun?.capabilityKnown ? '无' : '未知'}`,
      `TUN 网卡：${data.tun?.device || '—'}${data.tun?.active ? '（已发现）' : '（未发现）'}`,
      ...(data.tun?.capabilityError ? [`能力设置错误：${data.tun.capabilityError}`] : []),
      `系统代理：${data.systemProxy?.enabled ? `已开启（${data.systemProxy.port}）` : '未开启'} · /etc/environment ${data.systemProxy?.writable ? '当前用户可写' : '需 root/sudo'}`,
      `服务模式：${data.serviceMode?.ready ? '已初始化' : '未初始化'}${data.serviceMode?.helperDir ? `（${data.serviceMode.helperDir}）` : ''}`,
      `系统 DNS：${data.dns?.servers?.length ? data.dns.servers.join('、') : '未知'}`,
      `网络：allow-lan=${data.config?.allowLan === true ? 'true' : data.config?.allowLan === false ? 'false' : '未设置'} · bind-address=${data.config?.bindAddress || '默认'} · 端口=${Object.entries(data.config?.ports || {}).map(([name, port]) => `${name}:${port}`).join('，') || '未配置'}`,
      `认证：${data.config?.authentication ? '已启用（局域网客户端需用户名密码）' : '未启用'} · 模式：${modeLabel(data.config?.mode) || '—'}`,
      '',
      '局域网地址：',
      ...(data.network?.addresses?.length ? data.network.addresses.map(item => `  ${item.iface}: ${item.address}`) : ['  未发现局域网 IPv4 地址']),
      '',
      '端口可达性：',
      ...(data.network?.checks?.length ? data.network.checks.map(item => `  ${item.address}:${item.port}（${item.name}） ${item.reachable ? '可连接' : '无法连接'}`) : ['  未执行（内核未运行）']),
      '',
      '建议：',
      ...(data.hints?.length ? data.hints.map(item => `  - ${item}`) : ['  暂无']),
    ];
    $('diagnostics-output').textContent = lines.join('\n');
  });
  $('test-url-button').addEventListener('click', async () => {
    const button = $('test-url-button');
    const output = $('connectivity-output');
    const url = $('test-url').value.trim();
    if (!url) { output.textContent = '请输入测试网址。'; return; }
    button.disabled = true;
    button.textContent = '测试中…';
    const data = await act(() => post('connectivity', { url }), '', { silent: true });
    button.disabled = false;
    button.textContent = '测试';
    if (!data) {
      output.textContent = `失败：${state.lastError || '请求失败'}`;
      return;
    }
    if (data.skipped) {
      output.textContent = [`网址：${data.url}`, `结果：跳过`, `说明：${data.reason}`].join('\n');
      return;
    }
    const proxy = data.proxy?.enabled ? `系统代理 127.0.0.1:${data.proxy.port}` : '未启用系统代理（直连）';
    const result = data.ok
      ? `HTTP ${data.code || '—'}${data.seconds ? ` · ${data.seconds}s` : ''}`
      : `失败：${data.error || '未知错误'}`;
    output.textContent = [`网址：${data.url}`, `方式：${proxy}`, `结果：${result}`].join('\n');
  });
}

/* ------------------------------------------------------------------ helper */

function askPassword(title, text) {
  return new Promise(resolve => {
    const dialog = $('password-dialog');
    $('password-title').textContent = title;
    $('password-text').textContent = text;
    $('password-input').value = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(value);
    };
    $('password-accept').onclick = () => finish($('password-input').value);
    $('password-input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); finish($('password-input').value); } };
    dialog.addEventListener('close', () => { if (!settled) { settled = true; resolve(null); } }, { once: true });
    dialog.showModal();
    $('password-input').focus();
  });
}

function askConfirm(title, text) {
  return new Promise(resolve => {
    const dialog = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(value);
    };
    $('confirm-accept').onclick = () => finish(true);
    dialog.addEventListener('close', () => { if (!settled) { settled = true; resolve(false); } }, { once: true });
    dialog.showModal();
  });
}

function wireDialogs() {
  for (const element of document.querySelectorAll('[data-close]')) {
    element.addEventListener('click', () => $(element.dataset.close)?.close());
  }
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  }
}

function createVirtualList(container, rowHeight, renderRow) {
  const viewport = node('div', '', 'virtual-viewport');
  const spacer = node('div', '', 'virtual-spacer');
  const windowEl = node('div', '', 'virtual-window');
  viewport.append(spacer);
  spacer.append(windowEl);
  container.replaceChildren(viewport);
  let items = [];
  const update = () => {
    const start = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 6);
    const visible = Math.ceil((viewport.clientHeight || 480) / rowHeight) + 12;
    const end = Math.min(items.length, start + visible);
    spacer.style.height = `${items.length * rowHeight}px`;
    windowEl.style.transform = `translateY(${start * rowHeight}px)`;
    windowEl.replaceChildren(...items.slice(start, end).map((item, index) => renderRow(item, start + index)));
  };
  viewport.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  return { setItems(next) { items = next; update(); }, update };
}

/* -------------------------------------------------------------------- init */

function wireNavigation() {
  for (const item of document.querySelectorAll('.nav-item')) item.addEventListener('click', () => showView(item.dataset.view));
}

function wireSideControls() {
  $('side-start').addEventListener('click', async () => {
    if (state.starting) return;
    state.starting = true;
    if (state.status) renderSidebar(state.status);
    watchPreparation();
    try {
      const result = await privilegedAct(async password => post('core/start', { password }), '内核已启动', { softError: true });
      if (result) refreshProxies();
      else await reportLongActionError('内核启动失败');
    } finally {
      state.starting = false;
      await refreshStatus();
    }
  });
  $('side-stop').addEventListener('click', async () => {
    if (!(await askConfirm('停止内核', '停止后经由本机代理端口的连接会中断。'))) return;
    const result = await act(() => post('core/stop'), '内核已停止');
    if (result) { await refreshStatus(); state.proxies = null; }
  });
  $('side-restart').addEventListener('click', async () => {
    if (!(await askConfirm('重启内核', '将短暂中断代理连接。'))) return;
    watchPreparation();
    const result = await privilegedAct(async password => post('core/restart', { password }), '内核已重启', { softError: true });
    if (result) { await refreshStatus(); refreshProxies(); }
    else await reportLongActionError('内核重启失败');
  });
  const systemProxyInputs = [$('toggle-system-proxy'), $('set-system-proxy')];
  const tunInputs = [$('toggle-tun'), $('set-tun')];
  const setInputs = (inputs, value) => { for (const input of inputs) input.checked = value; };
  for (const input of systemProxyInputs) input.addEventListener('change', async event => {
    const enabled = event.target.checked;
    setInputs(systemProxyInputs, enabled);
    for (const item of systemProxyInputs) item.disabled = true;
    const result = await privilegedAct(async password => post('settings/system-proxy', { enabled, password }), '');
    for (const item of systemProxyInputs) item.disabled = false;
    await refreshStatus();
    if (result) notify(enabled ? (result.environment?.systemProxy ? '系统代理已开启' : '已记录，启动 Core 后自动开启') : '系统代理已关闭', 'success');
  });
  for (const input of tunInputs) input.addEventListener('change', async event => {
    const enabled = event.target.checked;
    setInputs(tunInputs, enabled);
    for (const item of tunInputs) item.disabled = true;
    const result = await privilegedAct(async password => post('settings/tun', { enabled, password }), '');
    for (const item of tunInputs) item.disabled = false;
    await refreshStatus();
    if (result) notify(enabled ? (result.environment?.tunActive ? '增强模式已开启' : '已记录，启动 Core 后自动开启') : '增强模式已关闭', 'success');
    if (result && state.view === 'proxies') refreshProxies();
  });
  for (const item of document.querySelectorAll('.side-modes button')) item.addEventListener('click', async () => {
    const mode = item.dataset.mode;
    const result = await act(() => post('mode/set', { mode }), '', { silent: true });
    if (!result) return;
    await refreshStatus();
    refreshProxies();
    if (mode === 'global') notify('已切换到全局模式；请在 GLOBAL 策略组选择出口节点，若为 DIRECT 则不会经过代理', 'warning', 7000);
    else notify(`已切换为${modeLabel(mode)}模式`, 'success');
  });
}

function connectStreams() {
  const logSource = new EventSource(`${BASE}/api/logs/stream`);
  let lastLogSeq = 0;
  logSource.onmessage = event => {
    try {
      const entry = JSON.parse(event.data);
      if (entry.seq && entry.seq <= lastLogSeq) return;
      if (entry.seq) lastLogSeq = entry.seq;
      state.logs.push(entry);
      if (state.logs.length > 1500) state.logs.splice(0, state.logs.length - 1500);
      scheduleLogRender();
    } catch { /* ignore malformed event */ }
  };
  const trafficSource = new EventSource(`${BASE}/api/traffic/stream`);
  trafficSource.onmessage = event => {
    try {
      const traffic = JSON.parse(event.data);
      updateTraffic(traffic);
      if (state.status?.core) state.status.core.traffic = traffic;
    } catch { /* ignore malformed event */ }
  };
}

async function main() {
  wireNavigation();
  wireDialogs();
  wireSideControls();
  wireProxies();
  wireConnections();
  wireConfig();
  $('prepare-toggle').addEventListener('click', togglePreparation);
  wireSubscriptions();
  wireLogs();
  wireSettings();
  logVirtual = createVirtualList($('log-list'), 34, logRow);
  connVirtual = createVirtualList($('connection-list'), 46, connectionRow);
  $('log-empty').hidden = true;
  $('conn-empty').hidden = false;
  connectStreams();
  watchAppUpdates({ endpoint: `${BASE}/api/update` });
  await refreshStatus();
  if (state.status?.core.running) refreshProxies();
  setInterval(refreshStatus, 3000);
  setInterval(() => { if (state.view === 'proxies' || state.view === 'overview') refreshProxies(); }, 6000);
  setInterval(() => { if (state.view === 'connections') refreshConnections(); }, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
}

main();
