import { toast } from '@fnos/toast';
import { watchAppUpdates } from '@fnos/version-check/client';
import { createJobFeedback } from './job-feedback.mjs';

const $ = id => document.getElementById(id);
const base = '/app/ffmpeg-for-fnos/api';
let state, checking = false, acting = false, polling = false, confirmAction, availableKey, revision = 0;
const reportJob = createJobFeedback(toast);
const size = bytes => `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)} MiB`;
function node(tag, text, className) { const result = document.createElement(tag); result.textContent = text; if (className) result.className = className; return result; }
async function request(route, data) {
  const response = await fetch(base + route, { cache: 'no-store', ...(data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-fnos-request': '1' }, body: JSON.stringify(data) }) });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || `请求失败：${response.status}`);
  return value;
}
function error(error) { toast({ type: 'error', content: error.message, duration: 7000 }); }
function busy() { return acting || checking || state?.job.state === 'running'; }
function selected() { return state?.available.find(item => item.id === $('branch').value); }
function renderDownload() {
  const entry = selected();
  $('available').hidden = !entry; $('available-empty').hidden = !!entry || state.job.state === 'running';
  if (entry) {
    $('build-detail').textContent = `${entry.source} · ffmpeg ${entry.size == null ? '大小待获取' : size(entry.size)}${state.ffprobeEnabled ? '，ffprobe 另行下载' : ''}`;
    const installed = state.installed.some(item => item.id === entry.id);
    $('install').textContent = installed ? '已安装' : '下载并安装';
    $('install').disabled = busy() || installed || !state.supported;
  }
}
function render() {
  const active = state.installed.find(item => item.id === state.active);
  $('active-version').textContent = (active?.format === 'components' ? active.build : active?.version) || (state.active ? '版本异常' : '尚未启用版本');
  $('active-detail').textContent = active && !active.invalid ? `ffmpeg${active.hasFFprobe ? ' + ffprobe' : ''}` : '下载后在列表中启用';
  const notices = [];
  if (!state.supported) notices.push('本机预览，版本操作请在 fnOS 上完成。');
  if (state.activeError) notices.push(`当前版本异常：${state.activeError}`);
  if (state.supported && state.commands.some(item => !item.registered && (item.name === 'ffmpeg' || state.ffprobeEnabled))) notices.push('全局命令链接未就绪或存在冲突，请检查应用安装状态。');
  $('notice').hidden = !notices.length; $('notice').textContent = notices.join(' ');
  for (const item of state.commands) $(`${item.name}-state`).textContent = !item.installed ? (item.name === 'ffprobe' ? '当前版本未安装' : '尚未启用') : item.registered ? '可用' : '入口未注册';
  $('copy-probe').disabled = !state.commands.some(item => item.name === 'ffprobe' && item.installed);
  if (!acting) $('enable-probe').checked = state.job.state === 'running' && state.job.action === 'probe' ? state.job.id : state.ffprobeEnabled;
  $('enable-probe').disabled = busy() || !state.supported;
  $('architecture').textContent = state.arch === 'x64' ? 'x86_64' : state.arch === 'arm64' ? 'ARM64' : state.arch;
  $('count').textContent = state.installed.length;
  $('installed-empty').hidden = !!state.installed.length;
  $('diagnostics').disabled = busy() || !state.active || !!state.activeError;
  $('rollback').disabled = busy() || !state.previous || state.previous === state.active || !state.supported;
  $('rollback').title = state.previous || '启用过两个版本后可以回滚';
  $('check').disabled = busy() || !state.supported;
  $('check').textContent = checking ? '检查中…' : '检查版本';
  const optionsKey = JSON.stringify(state.available.map(item => [item.id, item.build]));
  if (optionsKey !== availableKey) {
    const selectedID = $('branch').value;
    $('branch').replaceChildren(...state.available.map(item => { const option = node('option', item.build); option.value = item.id; return option; }));
    if (state.available.some(item => item.id === selectedID)) $('branch').value = selectedID;
    availableKey = optionsKey;
  }
  $('branch').disabled = busy(); renderDownload();
  $('version-list').replaceChildren(...state.installed.map(item => {
    const row = node('div', '', 'version-row'), copy = node('div', '', 'version-copy'), title = node('div', '', 'version-title');
    title.append(node('strong', (item.format === 'components' ? item.build : item.version) || item.id));
    if (item.active) title.append(node('em', '当前启用'));
    if (item.id === state.previous && !item.active) title.append(node('em', '上一版本'));
    if (!item.invalid) title.append(node('em', item.hasFFprobe ? '含 ffprobe' : '仅 ffmpeg'));
    copy.append(title, node('small', item.invalid ? '版本记录异常，请重新下载' : `${item.source || 'BtbN'} · ${size(item.diskSize)}`));
    const actions = node('div', '', 'actions');
    if (!item.active) {
      const activate = node('button', '启用'); activate.type = 'button'; activate.disabled = busy() || item.invalid || !state.supported;
      activate.onclick = () => confirm('启用此版本？', `切换至 ${item.build}，已启动的任务不受影响。`, () => operate('activate', item.id));
      const remove = node('button', '删除', 'danger'); remove.type = 'button'; remove.disabled = busy() || !state.supported;
      remove.onclick = () => confirm('删除此版本？', `将删除 ${item.build || item.id} 的本地文件。若通过全局入口启动的命令仍在使用它，删除会被阻止。`, () => operate('remove', item.id));
      actions.append(activate, remove);
    }
    row.append(copy, actions); return row;
  }));
  $('operation').hidden = state.job.state !== 'running';
  $('job-detail').textContent = state.job.message;
  $('download-size').textContent = '';
  if (state.job.total && state.job.message.includes('下载')) {
    $('progress').value = state.job.received / state.job.total * 100;
    $('download-size').textContent = `${size(state.job.received)} / ${size(state.job.total)}`;
  } else $('progress').removeAttribute('value');
}
async function refresh(force = false) {
  if (polling || acting) return;
  polling = true;
  const requestedRevision = revision;
  try {
    const next = await request('/status'), changed = JSON.stringify(next) !== JSON.stringify(state);
    if (requestedRevision !== revision) return;
    state = next;
    reportJob(state.job);
    if (changed || force === true) render();
    $('connection').hidden = true;
  }
  catch (issue) { if (requestedRevision === revision) { $('connection').hidden = false; $('connection').textContent = `连接失败：${issue.message}`; } }
  finally { polling = false; }
}
async function operate(action, id) {
  return mutate(`/version/${action}`, { id });
}
async function mutate(route, data) {
  acting = true; revision++; render();
  try {
    const result = await request(route, data);
    state.job = result.job; reportJob(result.job);
  }
  catch (issue) { error(issue); }
  finally { acting = false; render(); await refresh(true); }
}
function confirm(title, text, action) {
  $('confirm-title').textContent = title; $('confirm-text').textContent = text;
  confirmAction = action; $('confirm-dialog').showModal();
}
$('cancel-confirm').onclick = () => $('confirm-dialog').close();
$('accept-confirm').onclick = () => { $('confirm-dialog').close(); confirmAction?.(); };
$('close-diagnostics').onclick = () => $('diagnostics-dialog').close();
$('refresh').onclick = refresh;
$('branch').onchange = renderDownload;
$('enable-probe').onchange = async () => {
  const enabled = $('enable-probe').checked;
  await mutate('/component/ffprobe', { enabled });
};
$('check').onclick = async () => {
  checking = true; render();
  try { const result = await request('/version/check', {}); state.available = result.available; toast({ type: 'success', content: result.available.length ? `找到 ${result.available.length} 个可用版本` : '暂无可用版本' }); }
  catch (issue) { error(issue); }
  finally { checking = false; render(); }
};
$('install').onclick = () => { const entry = selected(); if (entry) operate('install', entry.id); };
$('rollback').onclick = () => confirm('回滚到上一版本？', `将全局命令切换至 ${state.previous}。已启动的命令继续运行。`, () => operate('rollback'));
$('diagnostics').onclick = async () => {
  acting = true; render();
  try {
    const result = await request('/diagnostics', {});
    $('diagnostics-output').textContent = `${result.build}\n\n${result.hwaccels}\n\n${result.encoders || ''}`;
    $('diagnostics-dialog').showModal();
  } catch (issue) { error(issue); }
  finally { acting = false; render(); }
};
for (const button of document.querySelectorAll('[data-copy]')) button.onclick = async () => {
  try { await navigator.clipboard.writeText(button.dataset.copy); toast({ type: 'success', content: '路径已复制' }); }
  catch { toast({ content: `请手动复制：${button.dataset.copy}`, duration: 7000 }); }
};
await refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 2500);
watchAppUpdates({ endpoint: `${base}/update`, interval: 60 * 60 * 1000 });
