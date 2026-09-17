import { ICONS } from '../../shared/icons.mjs';
import { elapsedLabel } from './format.mjs';
const base = '/app/dsh-for-fnos';
const $ = id => document.getElementById(id);
const registries = new Set(['https://mirrors.cloud.tencent.com/npm', 'https://registry.npmmirror.com', 'https://registry.yarnpkg.com', 'https://registry.npmjs.org']);
$('restart').innerHTML = ICONS.restart; $('open').innerHTML = ICONS.undo;
let state; let initialized = false; let submitting = false; let settingsDirty = false; let lastSnapshot = ''; let previousBusy = null; let noticeTimer;
function notice(message, error = false, duration = error ? 6500 : 3200) { clearTimeout(noticeTimer); const element = $('notice'); element.hidden = !message; element.textContent = message; element.className = error ? 'error' : ''; if (message && duration) noticeTimer = setTimeout(() => { element.hidden = true; }, duration); }
async function api(route, data) { const response = await fetch(`${base}/api/${route}`, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-fnos-request': '1' }, body: JSON.stringify(data) }); const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '请求失败'); return result; }
function button(label, action, version) { const element = document.createElement('button'); element.textContent = label; element.disabled = !!state.busy || !!state.globalBusy; element.addEventListener('click', () => perform(action, { version })); return element; }
function removeButton(version, current) { const element = button('删除', 'remove', version); element.className = 'danger'; element.disabled = element.disabled || current; if (current) element.title = '当前账户正在使用此版本'; element.addEventListener('click', event => { if (!confirm(`删除 DSH ${version}？已安装的运行时文件会被移除。`)) event.stopImmediatePropagation(); }, { capture: true }); return element; }
function renderGlobalTask(task) {
  const element = $('download-task');
  element.hidden = task?.type !== 'download';
  if (element.hidden) return;
  const step = Math.max(1, Math.min(Number(task.step) || 1, Number(task.total) || 4));
  const total = Number(task.total) || 4;
  const elapsed = Math.max(0, Math.floor((Date.now() - Number(task.startedAt || Date.now())) / 1000));
  $('download-task-title').textContent = `正在下载 ${task.version}`;
  $('download-task-step').textContent = `${step} / ${total}`;
  $('download-task-detail').textContent = `${task.stage || '处理中'} · 已用时 ${elapsedLabel(elapsed)}`;
  $('download-task-bar').style.width = `${step / total * 100}%`;
  const progress = element.querySelector('[role=progressbar]');
  progress.setAttribute('aria-valuemin', '1'); progress.setAttribute('aria-valuemax', String(total)); progress.setAttribute('aria-valuenow', String(step)); progress.setAttribute('aria-valuetext', task.stage || '处理中');
}
function serviceState(service) {
  if (service.busy) return `正在${service.busy}`;
  if (!service.idle) return service.activeConnections ? `使用中 · ${service.activeConnections} 个连接` : '使用中';
  const remaining = Math.max(0, Math.ceil((Number(service.closesAt) - Date.now()) / 1000));
  const closeAt = new Date(service.closesAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `空闲 · 预计 ${closeAt} 关闭（约 ${elapsedLabel(remaining)}）`;
}
function renderServices() {
  const target = $('services'); target.replaceChildren();
  const services = state.services ?? [];
  if (!services.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '当前没有运行中的 DSH 服务。'; target.append(empty); return; }
  for (const service of services) {
    const row = document.createElement('div'); row.className = 'service-row';
    const info = document.createElement('div'); const title = document.createElement('strong'); title.textContent = `用户 ${service.uid}`;
    const detail = document.createElement('small'); detail.textContent = `DSH ${service.version ?? '未知版本'} · ${serviceState(service)}`; info.append(title, detail);
    const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'danger service-stop'; stop.textContent = '关闭服务'; stop.disabled = !!service.busy || !!state.globalBusy;
    stop.addEventListener('click', async () => { if (!confirm(`关闭用户 ${service.uid} 的 DSH 服务？未保存的运行任务可能会中断。`)) return; await stopService(service.uid); });
    row.append(info, stop); target.append(row);
  }
}
function render() {
  const activeBusy = state.globalBusy || state.busy;
  const label = state.globalBusy ? state.globalBusy : state.busy ? `${state.busy} / ${state.current ?? ''}` : state.running ? `运行中 / ${state.current}` : state.current ? `已停止 / ${state.current}` : '未安装';
  $('runtime-text').textContent = label; $('runtime').className = state.globalBusy || state.busy ? 'busy' : state.running ? 'running' : '';
  renderGlobalTask(state.globalTask);
  renderServices();
  $('count').textContent = `${state.versions.length} 个版本`; $('market-status').textContent = state.marketInstalled ? 'dsh-market 已完成初次安装。' : '初次启动会自动安装 dsh-market；失败后可以重试。';
  document.querySelectorAll('button:not(#open):not(.service-stop)').forEach(x => { x.disabled = !!activeBusy; }); $('open').disabled = !state.running || !!state.busy; $('restart').disabled = !state.current || !!activeBusy;
  $('versions').replaceChildren(); if (!state.versions.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '尚未安装 DSH。首次安装会下载并启动 latest，也可以指定版本下载。'; $('versions').append(p); }
  for (const item of state.versions) { const row = document.createElement('div'); row.className = 'version-row'; const text = document.createElement('div'); const title = document.createElement('strong'); title.textContent = item.version; const current = item.version === state.current; const date = document.createElement('small'); date.textContent = `安装于 ${new Date(item.installedAt).toLocaleString('zh-CN')}${current ? ' / 当前账户使用中' : ''}`; text.append(title, date); row.append(text); const actions = document.createElement('div'); actions.className = 'version-actions'; if (item.version === state.defaultVersion) { const badge = document.createElement('span'); badge.className = 'active'; badge.textContent = '默认版本'; actions.append(badge); } else actions.append(button('设为默认', 'default', item.version), removeButton(item.version, current)); row.append(actions); $('versions').append(row); }
  $('releases').replaceChildren(); for (const release of state.releases) { const row = document.createElement('div'); row.className = 'release'; const text = document.createElement('span'); text.textContent = `${release.channel} / ${release.error ?? release.version}`; row.append(text); if (!release.error) { if (state.versions.some(x => x.version === release.version)) { const done = document.createElement('span'); done.textContent = '已下载'; row.append(done); } else row.append(button('下载', 'download', release.version)); } $('releases').append(row); }
  if (!initialized || !settingsDirty) {  $('registry').value = registries.has(state.config.registry) ? state.config.registry : 'https://mirrors.cloud.tencent.com/npm'; $('idle-timeout').value = String(state.config.idleTimeoutSeconds ?? 600); document.querySelectorAll('[name=channel]').forEach(x => { x.checked = state.config.channels.includes(x.value); }); initialized = true; }
  if (state.globalError || state.error) notice(state.globalError || state.error, true); else if (previousBusy && !activeBusy) notice('操作已完成。'); previousBusy = activeBusy;
}
async function refresh() { const next = await api('status'); const snapshot = JSON.stringify(next); state = next; if (snapshot !== lastSnapshot) { lastSnapshot = snapshot; render(); } else { renderGlobalTask(next.globalTask); renderServices(); } }
async function perform(action, data = {}) { if (submitting || state?.busy || state?.globalBusy) return; submitting = true; try { await api(action, data); notice('操作已提交。'); await refresh(); } catch (error) { notice(error.message, true); } finally { submitting = false; } }
async function stopService(uid) { if (submitting || state?.globalBusy) return; submitting = true; try { await api('stop', { uid }); notice('服务已关闭。'); await refresh(); } catch (error) { notice(error.message, true); } finally { submitting = false; } }
document.querySelectorAll('[data-action]').forEach(x => x.addEventListener('click', () => perform(x.dataset.action)));
$('download-form').addEventListener('submit', event => { event.preventDefault(); perform('download', { version: $('version').value.trim() }); }); $('settings-form').addEventListener('input', () => { settingsDirty = true; });
$('settings-form').addEventListener('submit', async event => { event.preventDefault(); try { await api('settings', { port: state.config.port, publicHost: state.config.publicHost, registry: $('registry').value, idleTimeoutSeconds: Number($('idle-timeout').value), channels: ['latest', ...[...document.querySelectorAll('[name=channel]:checked')].map(x => x.value)] }); settingsDirty = false; notice('设置已保存。'); await refresh(); } catch (error) { notice(error.message, true); } });
$('open').addEventListener('click', async () => { try { const result = await api('launch', {}); location.replace(result.url); } catch (error) { notice(error.message, true); } });
await refresh().catch(error => notice(error.message, true)); setInterval(() => { if (!document.hidden) refresh().catch(error => notice(error.message, true)); }, 2500);
