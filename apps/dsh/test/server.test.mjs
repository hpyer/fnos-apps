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
  const service = await serve({ root, socket, environment: { DSH_HOME: path.join(root, 'home') } });
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
  assert.match(launcher.data, /正在打开 DSH/);
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
