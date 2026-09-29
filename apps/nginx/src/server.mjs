import http from 'node:http';
import { chmod, readFile, rm } from 'node:fs/promises';

export const PREFIX = '/app/nginx-for-fnos';
function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}
async function body(request, limit = 300000) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > limit) throw Error('请求内容过大');
  }
  return JSON.parse(data || '{}');
}
export async function serve(manager, { assets, socket, devPort } = {}) {
  const files = new Map(await Promise.all(['index.html', 'index.js', 'index.css'].map(async name => [name, await readFile(new URL(name, assets))])));
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const authorized = devPort !== undefined
        ? request.headers.host === `127.0.0.1:${server.address().port}`
        : /^\d+$/.test(request.headers['x-trim-userid'] || '') && request.headers['x-trim-isadmin'] === 'true';
      if (!authorized || request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: '仅限飞牛管理员访问' });
      if (url.pathname === PREFIX && request.method === 'GET') { response.writeHead(302, { location: PREFIX + '/' }); return response.end(); }
      const asset = url.pathname === PREFIX + '/' ? 'index.html' : url.pathname.slice(PREFIX.length + 1);
      if (request.method === 'GET' && files.has(asset) && url.pathname.startsWith(PREFIX + '/')) {
        response.writeHead(200, { 'content-type': { 'index.html': 'text/html; charset=utf-8', 'index.js': 'text/javascript; charset=utf-8', 'index.css': 'text/css; charset=utf-8' }[asset], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'" });
        return response.end(files.get(asset));
      }
      if (request.method === 'GET' && url.pathname === `${PREFIX}/api/status`) return json(response, 200, await manager.status());
      if (request.method === 'GET' && url.pathname === `${PREFIX}/api/site`) return json(response, 200, { name: url.searchParams.get('name'), source: await manager.listSite(url.searchParams.get('name')) });
      if (request.method !== 'POST' || !url.pathname.startsWith(`${PREFIX}/api/`)) return json(response, 404, { error: '未找到接口' });
      if (request.headers['x-fnos-request'] !== '1') return json(response, 403, { error: '请求校验失败' });
      const action = url.pathname.slice(`${PREFIX}/api/`.length);
      if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '需要 JSON 请求' });
      const input = await body(request);
      let result;
      switch (action) {
        case 'site/save': result = await manager.saveSite(input.name, input.source); break;
        case 'site/delete': result = await manager.deleteSite(input.name); break;
        case 'reload': result = await manager.exclusive(async () => { await manager.reload(); return { ok: true }; }); break;
        case 'service/start': result = await manager.exclusive(async () => { await manager.start(); return { ok: true }; }); break;
        case 'service/stop': result = await manager.exclusive(async () => { await manager.stop(); return { ok: true }; }); break;
        case 'version/activate': result = await manager.activateVersion(input.version); break;
        case 'version/check': result = await manager.checkOfficial(input.channel); break;
        case 'version/install': result = await manager.installOfficial(input.channel); break;
        case 'version/remove': result = await manager.removeVersion(input.version); break;
        case 'notification/settings': result = await manager.setNotification(input); break;
        case 'notification/test': result = await manager.testNotificationPath(input.path); break;
        case 'notification/check': result = await manager.checkNotification(); break;
        default: return json(response, 404, { error: '未找到接口' });
      }
      return json(response, 200, result);
    } catch (error) { return json(response, 400, { error: error.message }); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000;
  if (socket) await rm(socket, { force: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket || { host: '127.0.0.1', port: devPort }, resolve); });
  if (socket) await chmod(socket, 0o600);
  return { server, async close() { await new Promise(resolve => server.close(resolve)); if (socket) await rm(socket, { force: true }); } };
}
