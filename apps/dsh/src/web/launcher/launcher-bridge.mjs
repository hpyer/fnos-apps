import { TrimApp } from '@trimjs/web-app';

const OPEN_REQUEST = 'fnos-dsh/open-settings-document';
const OPEN_RESULT = 'fnos-dsh/open-settings-result';

function within(task, milliseconds, message) {
  return Promise.race([
    task,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds)),
  ]);
}

async function openSettingsDocument() {
  const path = globalThis.__FNOS_DSH_SETTINGS_DOCUMENT__;
  if (!path) throw new Error('配置文件共享目录不可用，请升级并重新安装 DSH for fnOS');
  const app = new TrimApp();
  await within(app.ready(), 3_000, '飞牛微应用连接超时');
  if (app.isStandaloneWeb) throw new Error('当前页面没有飞牛微应用宿主');
  await within(app.openFile(path), 8_000, '飞牛文件管理器未响应');
}

window.addEventListener('message', async event => {
  const request = event.data;
  const frame = document.getElementById('dsh-frame');
  if (request?.type !== OPEN_REQUEST || typeof request.id !== 'string' || event.source !== frame?.contentWindow) return;
  let result;
  try { await openSettingsDocument(); result = { ok: true }; }
  catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  event.source.postMessage({ type: OPEN_RESULT, id: request.id, ...result }, event.origin === 'null' ? '*' : event.origin);
});
