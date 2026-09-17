import { TrimApp } from '@trimjs/web-app';

const base = '/app/dsh-for-fnos';
const message = document.getElementById('message');
const title = document.getElementById('title');
const authorizeHome = document.getElementById('authorize-home');
const openSettings = document.getElementById('open-settings');
let navigating = false;
let starting = false;
let authorizingHome = false;
let home = '';
let homeRequest = null;

async function api(route, data) {
  const response = await fetch(`${base}/api/${route}`, data === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-fnos-request': '1' }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '请求失败');
  return result;
}
async function waitForHomeAccess() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!(await api('status')).needsHomeAuthorization) return true;
  }
  return false;
}
function within(task, milliseconds, error) {
  return Promise.race([task, new Promise((_, reject) => setTimeout(() => reject(new Error(error)), milliseconds))]);
}
async function resolveHome() {
  if (home) return home;
  homeRequest ??= within(api('home'), 5_000, '主目录信息读取超时').then(result => {
    if (typeof result.home !== 'string' || !result.home) throw new Error('未获取到当前用户的主目录');
    home = result.home;
    return home;
  });
  try { return await homeRequest; }
  finally { homeRequest = null; }
}
function showAuthorization(userRoot) {
  home = userRoot;
  title.textContent = '选择 DSH 工作目录';
  message.textContent = '请在“我的文件”中选择一个子目录。DSH 会将配置、会话和工作区保存到该目录中。';
  authorizeHome.hidden = false;
  openSettings.hidden = true;
}
function showOpening(isAdmin = false) {
  title.textContent = '正在打开 DSH';
  authorizeHome.hidden = true;
  openSettings.hidden = !isAdmin;
}
async function open() {
  if (navigating) return;
  try {
    const state = await api('status');
    if (state.needsHomeAuthorization) {
      showAuthorization(state.userRoot ?? state.userHome);
      return;
    }
    showOpening(state.isAdmin);
    // The first download and all recovery work remain observable in settings.
    if (!state.current) {
      if (state.isAdmin) { location.replace(`${base}/settings/`); return; }
      message.textContent = state.globalBusy ? `${state.globalBusy}，请稍候…` : '管理员尚未准备可用的 DSH 版本。';
      setTimeout(open, 2500);
      return;
    }
    if (!state.running) {
      message.textContent = state.error ? `DSH 尚未启动：${state.error}` : 'DSH 正在启动，请稍候…';
      if (!starting && !state.busy) {
        starting = true;
        api('start', {}).catch(error => { message.textContent = `无法启动 DSH：${error.message}`; }).finally(() => { starting = false; });
      }
      setTimeout(open, 1500);
      return;
    }
    navigating = true;
    message.textContent = '正在建立安全访问会话…';
    const result = await api('launch', {});
    // DSH itself forbids nested frames. Replacing this app frame keeps it in
    // the fnOS window while preserving DSH's own plugin and API behaviour.
    location.replace(result.url);
  } catch (error) {
    message.textContent = `无法打开 DSH：${error.message}`;
    setTimeout(open, 3000);
  }
}
async function authorizeUserHome() {
  if (authorizingHome) return;
  authorizingHome = true;
  message.textContent = '正在准备工作目录选择…';
  try {
    await resolveHome();
    message.textContent = '请在飞牛选择器中选择 DSH 工作目录…';
    const app = new TrimApp();
    await Promise.race([app.ready(), new Promise((_, reject) => setTimeout(() => reject(new Error('飞牛微应用连接超时')), 5_000))]);
    if (app.isStandaloneWeb) throw new Error('请在飞牛桌面端或 App 内选择工作目录');
    // fnOS grants directory ACL as part of its user-directory picker flow.
    // The user's storage root itself cannot be selected by the host.
    const result = await app.pickUserFile({ directory: true, title: '选择 DSH 工作目录', okText: '使用此目录', sidebarGroup: ['myFiles'], creatable: true });
    if (!result || result.code !== 0) {
      // The current fnOS picker reports a close/cancel as “Operation failed”.
      // Returning to the neutral prompt is clearer than treating it as an error.
      if (!result || /operation failed|cancel|取消/i.test(String(result.msg ?? ''))) { showAuthorization(home); return; }
      throw new Error(result.msg || '未选择工作目录');
    }
    const selected = result.data?.[0];
    if (typeof selected !== 'string') { showAuthorization(home); return; }
    home = (await api('home', { home: selected })).home;
    if (!(await waitForHomeAccess())) throw new Error('飞牛主目录授权尚未生效，请稍后重试');
    message.textContent = '工作目录已授权，正在启动 DSH…';
    await open();
  } catch (error) {
    message.textContent = `无法设置工作目录：${error.message}`;
  } finally { authorizingHome = false; }
}
authorizeHome.addEventListener('click', authorizeUserHome);
open();
