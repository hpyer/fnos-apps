import http from 'node:http';
import { chmod, readFile, rm } from 'node:fs/promises';
import { AppError } from './errors.mjs';

export const PREFIX = '/app/dnsmasq-for-fnos';
const TYPES = { 'index.html': 'text/html; charset=utf-8', 'index.js': 'text/javascript; charset=utf-8', 'index.css': 'text/css; charset=utf-8' };
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'" };
function json(response, status, value) { response.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); }
async function body(request) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new AppError('请求内容过大', 413); chunks.push(chunk); } if (!chunks.length) return {}; try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new AppError('请求不是有效 JSON'); } }
function admin(request, server, devPort) { if (request.headers['sec-fetch-site'] === 'cross-site') return false; if (devPort) return request.headers.host === `127.0.0.1:${server.address().port}`; return /^\d+$/.test(request.headers['x-trim-userid'] || '') && request.headers['x-trim-isadmin'] === 'true'; }

export async function serve(manager, { assets, socket = '', devPort = 0 } = {}) {
  const files = new Map(await Promise.all(Object.keys(TYPES).map(async name => [name, await readFile(new URL(name, assets))])));
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost'); if (!admin(request, server, devPort)) return json(response, 403, { error: '仅限飞牛管理员访问' });
      if (url.pathname === PREFIX && request.method === 'GET') { response.writeHead(302, { ...HEADERS, location: `${PREFIX}/` }); return response.end(); }
      const asset = url.pathname === `${PREFIX}/` ? 'index.html' : url.pathname.startsWith(`${PREFIX}/`) ? url.pathname.slice(PREFIX.length + 1) : '';
      if (request.method === 'GET' && TYPES[asset]) { response.writeHead(200, { ...HEADERS, 'content-type': TYPES[asset] }); return response.end(files.get(asset)); }
      if (request.method === 'GET') {
        if (url.pathname === `${PREFIX}/api/status`) return json(response, 200, manager.status());
        if (url.pathname === `${PREFIX}/api/config`) return json(response, 200, await manager.config());
        if (url.pathname === `${PREFIX}/api/diagnostics`) return json(response, 200, await manager.diagnostics());
        return json(response, 404, { error: '未找到接口' });
      }
      if (request.method !== 'POST' || !url.pathname.startsWith(`${PREFIX}/api/`) || request.headers['x-fnos-request'] !== '1') return json(response, 403, { error: '请求校验失败' });
      if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '需要 JSON 请求' });
      const input = await body(request); const action = url.pathname.slice(`${PREFIX}/api/`.length);
      const actions = { 'settings/save': () => manager.saveSettings(input), 'records/save': () => manager.saveRecords(input.records), 'records/delete': () => manager.deleteRecord(Number(input.index)), 'config/validate': () => manager.validateConfig(), 'service/start': () => manager.start(), 'service/stop': () => manager.stop(), 'service/restart': () => manager.restart(), 'privilege/apply': () => manager.applyCapability({ password: String(input.password || ''), user: String(input.user || '') }) };
      if (!actions[action]) return json(response, 404, { error: '未找到接口' }); return json(response, 200, await actions[action]());
    } catch (error) { return json(response, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : '服务内部错误，请查看应用日志' }); }
  });
  if (socket) await rm(socket, { force: true }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket || { host: '127.0.0.1', port: devPort }, resolve); }); if (socket) await chmod(socket, 0o660);
  return { server, close: () => new Promise(resolve => server.close(resolve)) };
}
