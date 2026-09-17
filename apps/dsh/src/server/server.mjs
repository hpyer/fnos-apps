import http from 'node:http';
import path from 'node:path';
import { readFile, chmod, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Manager } from '../runtime/manager.mjs';
import { FleetManager } from '../runtime/fleet.mjs';
import { Sessions, createDshGateway, json, body } from './gateway.mjs';
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
export async function serve({ root, environment, socket, dev = false, adminPort = 3081, manager, standalone = false }) {
  manager ??= standalone ? new Manager(root, environment) : new FleetManager(root, environment);
  await manager.init();
  const multiUser = typeof manager.context === 'function';
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
  const isUser = request => (dev ? request.headers.host === `127.0.0.1:${adminPort}` : !!request.headers['x-trim-userid']) && request.headers['sec-fetch-site'] !== 'cross-site';
  const isAdmin = request => isUser(request) && (dev || request.headers['x-trim-isadmin'] === 'true');
  const canUse = request => multiUser ? isUser(request) : isAdmin(request);
  // Origins are learned only from CSRF-protected launch requests. fnOS may
  // replace Host with its socket authority; use the browser Origin for WS.
  const browserOrigins = new Map();
  const identity = request => dev ? 'dev' : request.headers['x-trim-userid'];
  const contextFor = request => multiUser ? manager.context(identity(request), isAdmin(request)) : manager;
  const statusFor = request => multiUser ? manager.userStatus(identity(request), isAdmin(request)) : manager.status();
  // This is deliberately separate from status: the launcher needs the user's
  // root before it is allowed to select or start a DSH work directory.
  const homeFor = request => multiUser ? manager.userRoot(identity(request)) : manager.environment.HOME;
  function rememberOrigin(request) {
    if (!request.headers.origin || request.headers.origin === 'null') return;
    const origins = browserOrigins.get(identity(request)) || new Set();
    if (origins.size >= 8) origins.delete(origins.values().next().value);
    origins.add(request.headers.origin);
    browserOrigins.set(identity(request), origins);
  }
  const pathGateway = createDshGateway(manager, null, 0, hostBridge, {
    base: DSH_PREFIX, settingsUrl: `${PREFIX}/settings/`, subpathScript: files.get('subpath.js').toString(),
    authorize: canUse,
    authorizeUpgrade: request => canUse(request) && !!request.headers.origin && browserOrigins.get(identity(request))?.has(request.headers.origin),
    managerFor: contextFor,
  });
  const admin = http.createServer(async (request, response) => {
    try {
      if (!canUse(request)) return json(response, 403, { error: '请先登录飞牛账号' });
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === DSH_PREFIX) { response.writeHead(302, { location: `${DSH_PREFIX}/` }); return response.end(); }
      if (pathname.startsWith(`${DSH_PREFIX}/`)) {
        if (request.headers['x-fnos-request'] === '1') rememberOrigin(request);
        return pathGateway.emit('request', request, response);
      }
      if (request.method === 'GET' && pathname === PREFIX) { response.writeHead(302, { location: `${PREFIX}/` }); return response.end(); }
      if (request.method === 'GET' && pathname === `${PREFIX}/settings`) { response.writeHead(302, { location: `${PREFIX}/settings/` }); return response.end(); }
      if (pathname.startsWith(`${PREFIX}/settings`) && !isAdmin(request)) return json(response, 403, { error: '仅限飞牛管理员访问应用设置' });
      const name = pathname === `${PREFIX}/` ? 'launcher.html'
        : pathname === `${PREFIX}/settings/` ? 'admin.html'
        : pathname.startsWith(`${PREFIX}/settings/`) ? pathname.slice(`${PREFIX}/settings/`.length)
          : pathname.slice(PREFIX.length + 1);
      if (request.method === 'GET' && files.has(name) && ((pathname.startsWith(`${PREFIX}/settings/`) && (name.startsWith('admin.') || name === 'icons.mjs')) || (!pathname.startsWith(`${PREFIX}/settings/`) && (name.startsWith('launcher.') || name === 'launcher-bridge.js')))) {
        response.writeHead(200, { 'content-type': contentTypes[name], 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'self'; base-uri 'none'", 'x-content-type-options': 'nosniff' });
        return response.end(files.get(name));
      }
      if (request.method === 'GET' && pathname === `${PREFIX}/api/home`) return json(response, 200, { home: homeFor(request) });
      if (request.method === 'GET' && pathname === `${PREFIX}/api/status`) return json(response, 200, await statusFor(request));
      if (request.method !== 'POST' || !pathname.startsWith(`${PREFIX}/api/`)) return json(response, 404, { error: '未找到接口' });
      // The fnOS gateway may preserve the browser Origin while replacing Host
      // with its Unix-socket upstream authority. A custom header plus gateway
      // administrator authentication is the CSRF boundary here: cross-origin
      // browser code cannot add this header without an allowed CORS preflight.
      if (request.headers['x-fnos-request'] !== '1' || !request.headers['content-type']?.startsWith('application/json')) return json(response, 403, { error: '请求校验失败' });
      const action = pathname.slice(`${PREFIX}/api/`.length);
      const input = await body(request);
      if (action === 'home') {
        if (!multiUser) throw new Error('当前运行模式不支持选择工作目录');
        return json(response, 200, { home: await manager.setUserHome(identity(request), input.home) });
      }
      if (action === 'launch') {
        const activeManager = await contextFor(request);
        if (!activeManager.process.address && multiUser) await manager.dispatchUser(identity(request), isAdmin(request), 'start');
        if (!activeManager.process.address) throw new Error('DSH 尚未就绪');
        if (standalone) {
          const authority = publicAddress(request.headers.host, manager.config.publicHost, manager.config.port);
          const ticket = sessions.ticket(authority.host, { settingsUrl: managerSettingsAddress(request) });
          return json(response, 200, { url: `${authority.origin}/_fnos/bootstrap#${ticket}`, settingsDocument: activeManager.settingsDocument });
        }
        rememberOrigin(request);
        return json(response, 200, { url: `${DSH_PREFIX}/`, settingsDocument: activeManager.settingsDocument });
      }
      if (action === 'settings') {
        if (!isAdmin(request)) return json(response, 403, { error: '仅限管理员修改运行设置' });
        const next = validateConfig(input);
        if (multiUser) await manager.updateConfig(next);
        else await manager.exclusive('保存设置', async () => {
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
      if (action === 'stop') {
        if (!isAdmin(request)) return json(response, 403, { error: '仅限管理员关闭 DSH 服务' });
        if (multiUser) await manager.stopService(input.uid);
        else await manager.exclusive('关闭 DSH', () => manager.stopRuntime());
        return json(response, 200, { ok: true });
      }
      if (!['check', 'download', 'remove', 'default', 'activate', 'start', 'restart', 'market'].includes(action)) return json(response, 404, { error: '未知操作' });
      if (['check', 'download', 'remove', 'default'].includes(action)) {
        if (!isAdmin(request)) return json(response, 403, { error: '仅限管理员管理 DSH 运行时' });
        if (multiUser) manager.dispatchAdmin(action, input).catch(() => {});
        else manager.dispatch(action, input).catch(() => {});
      } else if (multiUser) {
        manager.dispatchUser(identity(request), isAdmin(request), action, input).catch(() => {});
      } else {
        if (action === 'start') manager.dispatch('restart', input).catch(() => {});
        else manager.dispatch(action, input).catch(() => {});
      }
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
