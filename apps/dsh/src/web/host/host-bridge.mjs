import { TrimApp } from '@trimjs/web-app';

const transport = globalThis.__DSH_TRANSPORT__ ?? {};
const upstreamFetch = transport.fetch ?? ((input, init) => globalThis.fetch(input, init));
let app;

async function fnosApp() {
  app ??= new TrimApp();
  await Promise.race([
    app.ready(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('飞牛微应用连接超时')), 5_000)),
  ]);
  return app;
}

function isSettingsDocumentRequest(input, init) {
  const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return method.toUpperCase() === 'POST' && new URL(url, globalThis.location?.origin ?? 'http://dsh.invalid').pathname === '/api/settings/openSettingsDocument';
}

async function requestId(input, init) {
  const text = input instanceof Request ? await input.clone().text() : init?.body;
  if (typeof text !== 'string') return null;
  const value = JSON.parse(text);
  return typeof value?.rpcId === 'string' ? value.rpcId : null;
}

function rpcResponse(rpcId, result) {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function openInFnOS() {
  const file = globalThis.__FNOS_DSH_SETTINGS_FILE__;
  if (!file) throw new Error('配置文件不可用');
  const client = await fnosApp();
  if (client.isStandaloneWeb) throw new Error('请在飞牛客户端中打开配置文件');
  await client.openFile(file);
}

globalThis.__FNOS_DSH_AUTHORIZE_DIRECTORY__ = async () => {
  const client = await fnosApp();
  if (client.isStandaloneWeb) throw new Error('请在飞牛应用设置中添加个人授权目录');
  const result = await client.pickUserFile({
    directory: true,
    title: '选择 DSH 可访问目录',
    okText: '确认授权',
    sidebarGroup: ['myFiles', 'otherShare', 'external', 'remote', 'favorites', 'team'],
  });
  if (result && result.code !== 0) throw new Error(result.msg || '目录授权失败');
  return result?.data ?? [];
};

async function openSettingsDocument(input, init) {
  let rpcId;
  try { rpcId = await requestId(input, init); }
  catch { return upstreamFetch(input, init); }
  if (!rpcId) return upstreamFetch(input, init);
  try {
    await openInFnOS();
    return rpcResponse(rpcId, { ok: true, value: { opened: true } });
  } catch (error) {
    return rpcResponse(rpcId, {
      ok: false,
      error: {
        code: 'gateway/internal',
        message: `无法从飞牛文件管理器打开配置文件：${error instanceof Error ? error.message : String(error)}`,
        details: {},
      },
    });
  }
}

globalThis.__DSH_TRANSPORT__ = {
  ...transport,
  ownsHost: true,
  fetch(input, init) {
    return isSettingsDocumentRequest(input, init) ? openSettingsDocument(input, init) : upstreamFetch(input, init);
  },
};
