const base = '/app/dsh-for-fnos';
const message = document.getElementById('message');
const settings = document.getElementById('settings');
let navigating = false;

async function api(route, data) {
  const response = await fetch(`${base}/api/${route}`, data === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-fnos-request': '1' }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '请求失败');
  return result;
}
async function open() {
  if (navigating) return;
  try {
    const state = await api('status');
    // The first download and all recovery work remain observable in settings.
    if (!state.current) { location.replace(`${base}/settings/`); return; }
    if (!state.running) {
      message.textContent = state.error ? `DSH 尚未启动：${state.error}` : 'DSH 正在启动，请稍候…';
      settings.hidden = false;
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
    settings.hidden = false;
    setTimeout(open, 3000);
  }
}
open();
