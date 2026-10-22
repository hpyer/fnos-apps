import http from 'node:http';
import { chmod, readFile, rm } from 'node:fs/promises';
import { GitHubReleaseSource, UpdateChecker, readAppVersion } from '@fnos/version-check';

export const PREFIX = '/app/ffmpeg-for-fnos';
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
  const version = await readAppVersion([new URL('./version', import.meta.url), new URL('../native/manifest', import.meta.url)]);
  const updateChecker = new UpdateChecker(new GitHubReleaseSource({ repository: 'hpyer/fnos-apps', tagPrefix: 'ffmpeg', filePrefix: 'ffmpeg-for-fnos', version }), { cacheMs: 60 * 60 * 1000 });
  const checkUpdate = () => updateChecker.check();
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
      if (request.method === 'GET' && url.pathname === `${PREFIX}/api/update`) return json(response, 200, await checkUpdate());
      if (request.method !== 'POST' || !url.pathname.startsWith(`${PREFIX}/api/`)) return json(response, 404, { error: '未找到接口' });
      if (request.headers['x-fnos-request'] !== '1') return json(response, 403, { error: '请求校验失败' });
      const action = url.pathname.slice(`${PREFIX}/api/`.length);
      if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '需要 JSON 请求' });
      const input = await body(request);
      let result, status = 200;
      switch (action) {
        case 'version/check': result = await manager.check(); break;
        case 'diagnostics': result = await manager.diagnostics(); break;
        case 'component/ffprobe': result = manager.start('probe', input.enabled); status = 202; break;
        case 'version/install':
        case 'version/activate':
        case 'version/remove':
        case 'version/rollback': result = manager.start(action.slice(8), input.id); status = 202; break;
        default: return json(response, 404, { error: '未找到接口' });
      }
      return json(response, status, result);
    } catch (error) { return json(response, 400, { error: error.message }); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000;
  if (socket) await rm(socket, { force: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket || { host: '127.0.0.1', port: devPort }, resolve); });
  if (socket) await chmod(socket, 0o660);
  return { server, async close() { await new Promise(resolve => server.close(resolve)); if (socket) await rm(socket, { force: true }); } };
}
