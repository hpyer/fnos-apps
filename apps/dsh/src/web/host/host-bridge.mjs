const transport = globalThis.__DSH_TRANSPORT__ ?? {};
const upstreamFetch = transport.fetch ?? ((input, init) => globalThis.fetch(input, init));
const OPEN_REQUEST = 'fnos-dsh/open-settings-document';
const OPEN_RESULT = 'fnos-dsh/open-settings-result';

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

function openInFnOS() {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => finish(new Error('飞牛文件管理器未响应，请重新打开 DSH 后再试')), 10_000);
    function finish(error) {
      clearTimeout(timeout);
      globalThis.removeEventListener('message', receive);
      error ? reject(error) : resolve();
    }
    function receive(event) {
      const result = event.data;
      if (event.source !== globalThis.parent || result?.type !== OPEN_RESULT || result.id !== id) return;
      finish(result.ok ? undefined : new Error(result.error || '无法打开配置文件'));
    }
    globalThis.addEventListener('message', receive);
    globalThis.parent.postMessage({ type: OPEN_REQUEST, id }, '*');
  });
}

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
