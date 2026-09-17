import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve, listen, PREFIX, publicAddress, managerSettingsAddress } from '../src/server/server.mjs';
import { DEFAULTS, writeJson, readJson } from '../src/shared/config.mjs';
async function freePort() {
  const server = http.createServer(); await listen(server, { host: '127.0.0.1', port: 0 });
  const port = server.address().port; await new Promise(r => server.close(r)); return port;
}
test('native admin routes require NAS administrator identity and custom-header CSRF protection; port collisions preserve settings', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-server-'));
  const port = await freePort();
  await writeJson(path.join(root, 'config.json'), { ...DEFAULTS, port });
  const socket = path.join(root, 'admin.sock');
  const service = await serve({ root, socket, standalone: true, environment: { DSH_HOME: path.join(root, 'home') } });
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  function request(route, { headers = {}, data } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: socket, path: PREFIX + route, method: data ? 'POST' : 'GET', headers: { host: 'nas.local:5666', ...headers } }, res => {
        let text = ''; res.on('data', x => { text += x; }); res.on('end', () => {
          const type = res.headers['content-type'] ?? '';
          resolve({ status: res.statusCode, data: type.startsWith('application/json') ? JSON.parse(text) : text, headers: res.headers });
        });
      });
      req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
    });
  }
  assert.equal((await request('/api/status')).status, 403);
  const user = { 'x-trim-userid': '1000', 'x-trim-isadmin': 'false' };
  assert.equal((await request('/api/status', { headers: user })).status, 403);
  const admin = { ...user, 'x-trim-isadmin': 'true' };
  const launcher = await request('/', { headers: admin });
  assert.equal(launcher.status, 200);
  assert.match(launcher.headers['content-type'], /^text\/html/);
  assert.match(launcher.data, /选择 DSH 工作目录/);
  const settings = await request('/settings/', { headers: admin });
  assert.equal(settings.status, 200);
  assert.match(settings.data, /运行设置/);
  const icons = await request('/settings/icons.mjs', { headers: admin });
  assert.equal(icons.status, 200);
  assert.match(icons.data, /iconfont-symbol/);
  assert.equal((await request('/api/status', { headers: admin })).status, 200);
  assert.equal((await request('/api/settings', { headers: admin, data: DEFAULTS })).status, 403);
  const post = { ...admin, 'x-fnos-request': '1', 'content-type': 'application/json', origin: 'http://nas.local:5666' };
  // fnOS may forward the original browser Origin while changing Host for the
  // Unix-socket upstream. The custom header remains the browser-enforced CSRF boundary.
  assert.equal((await request('/api/settings', { headers: { ...post, origin: 'http://gateway.internal' }, data: { ...DEFAULTS, port } })).status, 200);
  const occupied = http.createServer(); await listen(occupied, { host: '0.0.0.0', port: 0 });
  t.after(() => new Promise(r => occupied.close(r)));
  const failed = await request('/api/settings', { headers: post, data: { ...DEFAULTS, port: occupied.address().port } });
  assert.equal(failed.status, 400);
  assert.equal((await readJson(path.join(root, 'config.json'))).port, port);
  assert.equal(service.gateway.address().port, port);
  const nextPort = await freePort();
  assert.equal((await request('/api/settings', { headers: post, data: { ...DEFAULTS, port: nextPort, publicHost: '192.168.1.20', channels: ['beta'] } })).status, 200);
  assert.equal(service.gateway.address().port, nextPort);
  assert.deepEqual(service.manager.config.channels, ['latest', 'beta']);
  service.manager.process = {
    child: {},
    address: new URL('http://127.0.0.1:47000/?token=secret'),
    stop: async () => {},
  };
  const launched = await request('/api/launch', { headers: post, data: {} });
  assert.equal(launched.status, 200);
  assert.match(launched.data.url, /^http:\/\/192\.168\.1\.20:/);
});

test('explicit NAS address overrides an internal gateway host when opening DSH', () => {
  assert.equal(publicAddress('localhost:5666', '192.168.1.20', 3080).href, 'http://192.168.1.20:3080/');
  assert.equal(publicAddress('nas.local:5666', '', 3080).href, 'http://nas.local:3080/');
  assert.equal(publicAddress('gateway.internal:5666', '[2001:db8::1]', 3080).href, 'http://[2001:db8::1]:3080/');
  assert.throws(() => publicAddress('not a host', '', 3080));
});

test('settings navigation retains the fnOS gateway origin', () => {
  assert.equal(managerSettingsAddress({ headers: { host: 'nas.local:5666', 'x-forwarded-proto': 'https' } }), 'https://nas.local:5666/app/dsh-for-fnos/settings/');
  assert.equal(managerSettingsAddress({ headers: { host: 'nas.local:5666' } }), 'http://nas.local:5666/app/dsh-for-fnos/settings/');
});

test('multi-user gateway admits regular users but keeps runtime administration private', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-multi-server-'));
  const socket = path.join(root, 'app.sock');
  const actions = [];
  const tenant = {
    process: { child: {}, address: new URL('http://127.0.0.1:47000/'), authCookie: 'fixture' },
    settingsDocument: path.join(root, 'users/1001/home/.dsh/settings.yaml'),
    busy: null,
    status: async () => ({ current: '1.0.0', running: true, busy: null, error: null, versions: [{ version: '1.0.0' }], isAdmin: false }),
    dispatch: async (action, data) => { actions.push({ action, data }); },
  };
  const manager = {
    config: DEFAULTS,
    init: async () => {}, stop: async () => {},
    context: async () => tenant,
    userRoot: uid => `/vol1/${uid}`,
    setUserHome: async (uid, home) => {
      actions.push({ uid, home, action: 'home' });
      return home;
    },
    userStatus: async (_uid, isAdmin) => ({ ...await tenant.status(), isAdmin, config: isAdmin ? DEFAULTS : undefined }),
    dispatchUser: async (uid, isAdmin, action, data) => { actions.push({ uid, isAdmin, action, data }); },
    dispatchAdmin: async (action, data) => { actions.push({ action, data }); },
    stopService: async uid => { actions.push({ action: 'stop', uid }); },
    updateConfig: async () => {},
  };
  const service = await serve({ root, socket, manager });
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  function request(route, { headers = {}, data } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: socket, path: PREFIX + route, method: data ? 'POST' : 'GET', headers: { host: 'nas.local:5666', ...headers } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : text }));
      });
      req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
    });
  }
  const user = { 'x-trim-userid': '1001', 'x-trim-isadmin': 'false' };
  const post = { ...user, 'x-fnos-request': '1', 'content-type': 'application/json' };
  assert.equal((await request('/', { headers: user })).status, 200);
  const home = await request('/api/home', { headers: user });
  assert.deepEqual(home, { status: 200, data: { home: '/vol1/1001' } });
  assert.deepEqual(await request('/api/home', { headers: post, data: { home: '/vol1/1001/dsh_home' } }), { status: 200, data: { home: '/vol1/1001/dsh_home' } });
  assert.deepEqual(actions.at(-1), { uid: '1001', home: '/vol1/1001/dsh_home', action: 'home' });
  const status = await request('/api/status', { headers: user });
  assert.equal(status.status, 200);
  assert.equal(status.data.isAdmin, false);
  assert.equal((await request('/settings/', { headers: user })).status, 403);
  assert.equal((await request('/api/check', { headers: post, data: {} })).status, 403);
  assert.equal((await request('/api/remove', { headers: post, data: { version: '1.0.0' } })).status, 403);
  assert.equal((await request('/api/activate', { headers: post, data: { version: '1.0.0' } })).status, 202);
  assert.deepEqual(actions.at(-1), { uid: '1001', isAdmin: false, action: 'activate', data: { version: '1.0.0' } });
  const adminPost = { ...post, 'x-trim-isadmin': 'true' };
  assert.equal((await request('/api/remove', { headers: adminPost, data: { version: '1.1.0' } })).status, 202);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions.at(-1), { action: 'remove', data: { version: '1.1.0' } });
  assert.equal((await request('/api/stop', { headers: post, data: { uid: '1001' } })).status, 403);
  assert.equal((await request('/api/stop', { headers: adminPost, data: { uid: '1001' } })).status, 200);
  assert.deepEqual(actions.at(-1), { action: 'stop', uid: '1001' });
});
