import http from 'node:http';
import path from 'node:path';
import { readFile, chmod, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Manager } from '../runtime/manager.mjs';
import { Sessions, createDshGateway, json, body, sameOrigin } from './gateway.mjs';
import { validateConfig, writeJson } from '../shared/config.mjs';

export const PREFIX = '/app/dsh-for-fnos';
export const DSH_PREFIX = `${PREFIX}/dsh`;

// The manager gateway may see an internal Host from fnOS. A configured public
// host wins so the browser is always sent to a reachable DSH port.
export function publicAddress(requestHost, publicHost, port) {
  const source = publicHost || requestHost;
  let url;
  try { url = new URL(`http://${source}`); }
  catch { throw new Error('无法识别当前 NAS 的访问地址'); }
  if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('无法识别当前 NAS 的访问地址');
  }
  url.port = String(port);
  return url;
}

export function managerSettingsAddress(request) {
  const raw = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const protocol = raw === 'https' ? 'https:' : 'http:';
  const host = request.headers.host;
  if (!host) throw new Error('无法识别飞牛管理页地址');
  return new URL(`${PREFIX}/settings/`, `${protocol}//${host}`).href;
}

// Node's listen callback does not surface bind errors through a promise; this
// wrapper is also used when atomically testing a replacement DSH gateway port.
export function listen(server, target) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(target, () => { server.off('error', reject); resolve(); });
  });
}
async function close(server) {
  if (!server) return;
  server.closeConnections?.();
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
export async function serve({ root, environment, socket, dev = false, adminPort = 3081, manager = new Manager(root, environment), standalone = false }) {
  await manager.init();
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDirectory = path.dirname(modulePath);
  const sourceMode = modulePath.includes('/apps/dsh/src/');
  const assetRoot = dev ? path.resolve(moduleDirectory, '../../../../dist/dsh-for-fnos/app') : moduleDirectory;
  // Unit tests load source modules directly, while packaged code loads assets
  // from app/. Keep this map explicit so source layout never leaks into FPK.
  const assetFiles = sourceMode && !dev
    ? new Map([
      ['admin.html', '../web/admin/index.html'], ['admin.css', '../web/admin/index.css'], ['admin.js', '../web/admin/index.js'],
      ['subpath.js', '../web/host/subpath.js'], ['icons.mjs', '../shared/icons.mjs'], ['launcher.html', '../web/launcher/index.html'], ['launcher.css', '../web/launcher/index.css'], ['launcher.js', '../web/launcher/index.js'],
    ])
    : new Map(['subpath.js', 'admin.html', 'admin.css', 'admin.js', 'icons.mjs', 'launcher.html', 'launcher.css', 'launcher.js'].map(name => [name, name]));
  const files = new Map(await Promise.all([...assetFiles].map(async ([name, file]) => [name, await readFile(path.join(assetRoot, file))])));
  try { files.set('launcher-bridge.js', await readFile(path.join(assetRoot, 'launcher-bridge.js'))); }
  catch (error) {
    if (dev || !sourceMode) throw error;
    files.set('launcher-bridge.js', Buffer.from(''));
  }
  let hostBridge = '';
  try { hostBridge = await readFile(path.join(assetRoot, 'host-bridge.js'), 'utf8'); }
  catch (error) {
    // Source-mode unit tests do not run the browser bundle. Packaged and dev
    // builds always provide it; fail hard there so a release cannot omit it.
    if (dev || !sourceMode) throw error;
  }
  // Native and development entry points use the same-origin path gateway.
  // Keep the old listener opt-in for compatibility tests, never bind it by default.
  let sessions = new Sessions();
  let gateway = standalone ? createDshGateway(manager, sessions, manager.config.port, hostBridge) : null;
  const bind = port => ({ port, host: dev ? '127.0.0.1' : '0.0.0.0' });
  if (gateway) await listen(gateway, bind(manager.config.port));
  const contentTypes = {
    'admin.html': 'text/html; charset=utf-8', 'launcher.html': 'text/html; charset=utf-8',
    'admin.css': 'text/css', 'launcher.css': 'text/css',
    'admin.js': 'text/javascript', 'icons.mjs': 'text/javascript', 'launcher.js': 'text/javascript', 'launcher-bridge.js': 'text/javascript',
  };
  const isAdmin = request => (dev ? request.headers.host === `127.0.0.1:${adminPort}` : !!request.headers['x-trim-userid'] && request.headers['x-trim-isadmin'] === 'true') && request.headers['sec-fetch-site'] !== 'cross-site';
  // Origins are learned only from CSRF-protected launch requests. fnOS may
  // replace Host with its socket authority; use the browser Origin for WS.
  const browserOrigins = new Map();
  const identity = request => dev ? 'dev' : request.headers['x-trim-userid'];
  function rememberOrigin(request) {
    if (!request.headers.origin || request.headers.origin === 'null') return;
    const origins = browserOrigins.get(identity(request)) || new Set();
    if (origins.size >= 8) origins.delete(origins.values().next().value);
    origins.add(request.headers.origin);
    browserOrigins.set(identity(request), origins);
  }
  const pathGateway = createDshGateway(manager, null, 0, hostBridge, {
    base: DSH_PREFIX, settingsUrl: `${PREFIX}/settings/`, subpathScript: files.get('subpath.js').toString(),
    authorize: isAdmin,
    authorizeUpgrade: request => isAdmin(request) && !!request.headers.origin && browserOrigins.get(identity(request))?.has(request.headers.origin),
  });
  const admin = http.createServer(async (request, response) => {
    try {
      const authorized = isAdmin(request);
      if (!authorized) return json(response, 403, { error: '仅限飞牛管理员访问' });
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === DSH_PREFIX) { response.writeHead(302, { location: `${DSH_PREFIX}/` }); return response.end(); }
      if (pathname.startsWith(`${DSH_PREFIX}/`)) {
        if (request.headers['x-fnos-request'] === '1') rememberOrigin(request);
        return pathGateway.emit('request', request, response);
      }
      if (request.method === 'GET' && pathname === PREFIX) { response.writeHead(302, { location: `${PREFIX}/` }); return response.end(); }
      if (request.method === 'GET' && pathname === `${PREFIX}/settings`) { response.writeHead(302, { location: `${PREFIX}/settings/` }); return response.end(); }
      const name = pathname === `${PREFIX}/` ? 'launcher.html'
        : pathname === `${PREFIX}/settings/` ? 'admin.html'
        : pathname.startsWith(`${PREFIX}/settings/`) ? pathname.slice(`${PREFIX}/settings/`.length)
          : pathname.slice(PREFIX.length + 1);
      if (request.method === 'GET' && files.has(name) && ((pathname.startsWith(`${PREFIX}/settings/`) && (name.startsWith('admin.') || name === 'icons.mjs')) || (!pathname.startsWith(`${PREFIX}/settings/`) && (name.startsWith('launcher.') || name === 'launcher-bridge.js')))) {
        response.writeHead(200, { 'content-type': contentTypes[name], 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'self'; base-uri 'none'", 'x-content-type-options': 'nosniff' });
        return response.end(files.get(name));
      }
      if (request.method === 'GET' && pathname === `${PREFIX}/api/status`) return json(response, 200, await manager.status());
      if (request.method !== 'POST' || !pathname.startsWith(`${PREFIX}/api/`)) return json(response, 404, { error: '未找到接口' });
      // The fnOS gateway may preserve the browser Origin while replacing Host
      // with its Unix-socket upstream authority. A custom header plus gateway
      // administrator authentication is the CSRF boundary here: cross-origin
      // browser code cannot add this header without an allowed CORS preflight.
      if (request.headers['x-fnos-request'] !== '1' || !request.headers['content-type']?.startsWith('application/json')) return json(response, 403, { error: '请求校验失败' });
      const action = pathname.slice(`${PREFIX}/api/`.length);
      const input = await body(request);
      if (action === 'launch') {
        if (!manager.process.address) throw new Error('DSH 尚未就绪');
        if (standalone) {
          const authority = publicAddress(request.headers.host, manager.config.publicHost, manager.config.port);
          const ticket = sessions.ticket(authority.host, { settingsUrl: managerSettingsAddress(request) });
          return json(response, 200, { url: `${authority.origin}/_fnos/bootstrap#${ticket}`, settingsDocument: manager.settingsDocument });
        }
        rememberOrigin(request);
        return json(response, 200, { url: `${DSH_PREFIX}/`, settingsDocument: manager.settingsDocument });
      }
      if (action === 'settings') {
        await manager.exclusive('保存设置', async () => {
          const next = validateConfig(input);
          let replacement;
          let nextSessions;
          if (standalone && next.port !== manager.config.port) {
            // Bind before persisting or retiring the old gateway. A collision
            // then leaves the active instance and its saved configuration intact.
            nextSessions = new Sessions();
            replacement = createDshGateway(manager, nextSessions, next.port, hostBridge);
            await listen(replacement, bind(next.port));
          }
          try { await writeJson(path.join(root, 'config.json'), next); }
          catch (error) { if (replacement) await close(replacement); throw error; }
          manager.config = next;
          if (replacement) { const previous = gateway; gateway = replacement; sessions = nextSessions; await close(previous); }
        });
        return json(response, 200, { ok: true });
      }
      if (!['check', 'download', 'activate', 'restart', 'market'].includes(action)) return json(response, 404, { error: '未知操作' });
      if (manager.busy) return json(response, 409, { error: `正在${manager.busy}` });
      // Long downloads stay in the manager, independent of gateway request timeouts.
      manager.dispatch(action, input).catch(() => {});
      return json(response, 202, { ok: true });
    } catch (error) { json(response, 400, { error: error.message }); }
  });
  admin.on('upgrade', (request, socket, head) => pathGateway.emit('upgrade', request, socket, head));
  admin.on('connection', socket => pathGateway.trackConnection(socket));
  try {
    if (dev) await listen(admin, { host: '127.0.0.1', port: adminPort });
    else { await rm(socket, { force: true }); await listen(admin, socket); await chmod(socket, 0o660); }
  } catch (error) { await close(gateway); throw error; }
  return { manager, admin, get gateway() { return gateway; }, async stop() { pathGateway.closeConnections(); await manager.stop(); await Promise.all([close(admin), close(gateway)]); if (!dev) await rm(socket, { force: true }); } };
}
