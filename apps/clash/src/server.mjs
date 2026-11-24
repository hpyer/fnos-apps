import http from 'node:http';
import { chmod, readFile, rm } from 'node:fs/promises';
import { GitHubReleaseSource, UpdateChecker, readAppVersion } from '@fnos/version-check';
import { CredentialError, createCredentialKey, decryptCredential } from '@fnos/privilege/credential';
import { defaultConfig } from './config-template.mjs';
import { AppError, fail } from './errors.mjs';

export const PREFIX = '/app/clash-for-fnos';
const MAX_BODY = 3 * 1024 * 1024;
const STATIC_TYPES = {
  'index.html': 'text/html; charset=utf-8',
  'index.js': 'text/javascript; charset=utf-8',
  'index.css': 'text/css; charset=utf-8',
};
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
};

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function readBody(request, limit = MAX_BODY) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail('请求内容超过大小限制', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('请求内容不是有效 JSON'); }
}

function isAdmin(request, { server, devPort }) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (devPort !== undefined) return request.headers.host === `127.0.0.1:${server.address().port}`;
  return /^\d+$/.test(request.headers['x-trim-userid'] || '') && request.headers['x-trim-isadmin'] === 'true';
}

// 与 packages/privilege 的 runAsLoginUser 保持一致：只接受可安全用于 su 的账户名。
const LOGIN_USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;

async function gatewayUser(request) {
  // 网关注入的 x-trim-username 是权威登录名，必须优先使用；先查 /etc/passwd 会在
  // 非 fnOS 环境（CI、容器）把同 UID 的无关账户当成登录用户。
  const header = String(request.headers['x-trim-username'] || '').slice(0, 64);
  if (LOGIN_USER.test(header)) return header;
  const uid = String(request.headers['x-trim-userid'] || '');
  if (/^\d+$/.test(uid)) {
    try {
      const passwd = await readFile('/etc/passwd', 'utf8');
      for (const line of passwd.split('\n')) {
        const fields = line.split(':');
        if (fields[2] === uid && LOGIN_USER.test(fields[0])) return fields[0];
      }
    } catch { /* /etc/passwd unavailable */ }
  }
  return header;
}

function sse(response, extra = {}) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...SECURITY_HEADERS,
    ...extra,
  });
  response.write(': connected\n\n');
  return response;
}

export async function serve(manager, { assets, socket, devPort, getCredentialKey = () => '', setCredentialKey = () => {}, githubFetcher = globalThis.fetch } = {}) {
  const version = await readAppVersion([new URL('./version', import.meta.url), new URL('../native/manifest', import.meta.url)]);
  const updateChecker = new UpdateChecker(new GitHubReleaseSource({ repository: 'hpyer/fnos-apps', tagPrefix: 'clash', filePrefix: 'clash-for-fnos', version, fetcher: githubFetcher }), { cacheMs: 60 * 60 * 1000 });
  const checkUpdate = async () => {
    try {
      const result = await updateChecker.check();
      if (result?.update?.url) result.update.url = manager.mirrorUrl ? manager.mirrorUrl(result.update.url) : result.update.url;
      return result;
    }
    catch (error) { return { update: null, error: `检查更新失败：${error.message}` }; }
  };
  const files = new Map(await Promise.all(['index.html', 'index.js', 'index.css'].map(async name => [name, await readFile(new URL(name, assets))])));

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (!isAdmin(request, { server, devPort })) return json(response, 403, { error: '仅限飞牛管理员访问' });
      if (url.pathname === PREFIX && request.method === 'GET') {
        response.writeHead(302, { location: `${PREFIX}/`, ...SECURITY_HEADERS });
        return response.end();
      }
      const asset = url.pathname === `${PREFIX}/` ? 'index.html' : (url.pathname.startsWith(`${PREFIX}/`) ? url.pathname.slice(PREFIX.length + 1) : '');
      if (request.method === 'GET' && Object.hasOwn(STATIC_TYPES, asset)) {
        response.writeHead(200, { 'content-type': STATIC_TYPES[asset], ...SECURITY_HEADERS });
        return response.end(files.get(asset));
      }

      if (request.method === 'GET') {
        switch (url.pathname) {
          case `${PREFIX}/api/credential-key`: {
            const key = createCredentialKey();
            setCredentialKey(key.privateKey);
            return json(response, 200, { publicKey: key.publicKey });
          }
          case `${PREFIX}/api/status`: return json(response, 200, await manager.status());
          case `${PREFIX}/api/preparation`: return json(response, 200, { preparation: manager.preparationSnapshot() });
          case `${PREFIX}/api/update`: return json(response, 200, await checkUpdate());
          case `${PREFIX}/api/config`: return json(response, 200, await manager.readConfig());
          case `${PREFIX}/api/config/template`: return json(response, 200, { source: defaultConfig() });
          case `${PREFIX}/api/backups`: return json(response, 200, { backups: await manager.listBackups() });
          case `${PREFIX}/api/diagnostics`: return json(response, 200, await manager.diagnostics());
          case `${PREFIX}/api/data`: return json(response, 200, await manager.dataStatus());
          case `${PREFIX}/api/logs`: return json(response, 200, { logs: manager.logsHistory({ limit: Number(url.searchParams.get('limit')) || 300, minLevel: url.searchParams.get('level') || '' }) });
          case `${PREFIX}/api/proxies`: return json(response, 200, await manager.proxies());
          case `${PREFIX}/api/connections`: return json(response, 200, await manager.connections());
          case `${PREFIX}/api/logs/stream`: {
            sse(response);
            for (const entry of manager.logsHistory({ limit: 200 })) response.write(`data: ${JSON.stringify(entry)}\n\n`);
            const unsubscribe = manager.logs.subscribe(response);
            const heartbeat = setInterval(() => { try { response.write(': ping\n\n'); } catch { clearInterval(heartbeat); } }, 20000);
            request.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
            return;
          }
          case `${PREFIX}/api/traffic/stream`: {
            sse(response);
            const send = traffic => { try { response.write(`data: ${JSON.stringify(traffic)}\n\n`); } catch { /* closed */ } };
            send(manager.traffic);
            manager.on('traffic', send);
            const heartbeat = setInterval(() => { try { response.write(': ping\n\n'); } catch { clearInterval(heartbeat); } }, 20000);
            request.on('close', () => { clearInterval(heartbeat); manager.off('traffic', send); });
            return;
          }
          default: break;
        }
      }

      if (request.method !== 'POST' || !url.pathname.startsWith(`${PREFIX}/api/`)) return json(response, 404, { error: '未找到接口' });
      if (request.headers['x-fnos-request'] !== '1') return json(response, 403, { error: '请求校验失败' });
      if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '需要 JSON 请求' });
      let input = await readBody(request);
      if (input?.encryptedCredential) input = decryptCredential(input, getCredentialKey());
      const action = url.pathname.slice(`${PREFIX}/api/`.length);
      const user = await gatewayUser(request);
      switch (action) {
        case 'config/save': return json(response, 200, await manager.saveConfig(input.source));
        case 'config/validate': return json(response, 200, await manager.validateConfig(input.source));
        case 'config/restore': return json(response, 200, await manager.restoreBackup(input.id));
        case 'config/backup/delete': return json(response, 200, await manager.deleteBackup(input.id));
        case 'data/save': return json(response, 200, await manager.saveDataSettings(input));
        case 'data/sync-all': return json(response, 200, await manager.syncAllData({ restart: true }));
        case 'data/sync': return json(response, 200, await manager.syncData(String(input.key || ''), { url: String(input.url || '') }));
        case 'connectivity': return json(response, 200, await manager.testUrl(input.url));
        case 'settings/save': return json(response, 200, await manager.setSettings(input, { password: String(input.password || ''), user }));
        case 'settings/service-mode-init': return json(response, 200, await manager.initializeServiceMode({ password: String(input.password || ''), user }));
        case 'settings/system-proxy': return json(response, 200, await manager.setSystemProxy(input.enabled === true, { password: String(input.password || ''), user }));
        case 'settings/tun': return json(response, 200, await manager.setTun(input.enabled === true, { password: String(input.password || ''), user }));
        case 'core/start': return json(response, 200, await manager.startCore({ password: String(input.password || '') }));
        case 'core/stop': return json(response, 200, await manager.stopCore());
        case 'core/restart': return json(response, 200, await manager.restartCore({ password: String(input.password || '') }));
        case 'core/check': return json(response, 200, await manager.checkCores(input.channel));
        case 'core/install': return json(response, 202, await manager.startJob('install', input.id));
        case 'core/activate': return json(response, 202, await manager.startJob('activate', input.id));
        case 'core/rollback': return json(response, 202, await manager.startJob('rollback'));
        case 'core/remove': return json(response, 202, await manager.startJob('remove', input.id));
        case 'mode/set': return json(response, 200, await manager.setMode(input.mode));
        case 'subscription/add': return json(response, 200, await manager.addSubscription(input));
        case 'subscription/settings': return json(response, 200, await manager.updateSubscriptionSettings(input.id, input));
        case 'subscription/delete': return json(response, 200, await manager.deleteSubscription(input.id));
        case 'subscription/update': return json(response, 200, await manager.updateSubscription(input.id));
        case 'subscription/apply': return json(response, 200, await manager.applySubscription(input.id));
        case 'subscription/preview': return json(response, 200, await manager.previewSubscription(input.id));
        case 'proxy/select': return json(response, 200, await manager.selectProxy(input.group, input.name));
        case 'proxy/provider/refresh': return json(response, 200, await manager.refreshProvider(input.name));
        case 'proxy/delay': return json(response, 200, await manager.delay(input.name));
        case 'proxy/group-delay': return json(response, 200, await manager.groupDelay(input.group));
        case 'proxy/delay-all': return json(response, 200, await manager.delayAll());
        case 'connection/close': return json(response, 200, await manager.closeConnection(input.id));
        case 'connection/close-all': return json(response, 200, await manager.closeAllConnections());
        default: return json(response, 404, { error: '未找到接口' });
      }
    } catch (error) {
      const knownError = error instanceof AppError || error instanceof CredentialError;
      const status = knownError ? error.status : 500;
      if (!knownError && manager.log) manager.log('error', `接口异常：${error.message}`);
      if (response.headersSent) return response.end();
      return json(response, status, { error: knownError ? error.message : '服务内部错误，请查看应用日志' });
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 60000;
  if (socket) await rm(socket, { force: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket || { host: '127.0.0.1', port: devPort }, resolve);
  });
  if (socket) await chmod(socket, 0o660);
  return {
    server,
    async close() {
      await new Promise(resolve => server.close(resolve));
      if (socket) await rm(socket, { force: true });
    },
  };
}
