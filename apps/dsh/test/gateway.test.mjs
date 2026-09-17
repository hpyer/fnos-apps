import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createDshGateway, Sessions } from '../src/server/gateway.mjs';
import { listen } from '../src/server/server.mjs';

async function fixture(t) {
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/') {
      const page = '<!doctype html><html><head><title>DSH</title></head><body>ready</body></html>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(page) });
      res.end(page);
    } else if (req.url === '/api/settings/describe') {
      const payload = JSON.stringify({ rpcId: 'request', result: { ok: true, value: { writable: true, hasDocument: true, namespaces: [] } } });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    } else if (req.url === '/plugin/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: second\n\n'), 250);
    } else {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('base64') }));
    }
  });
  const upstreamSockets = new Set();
  upstream.on('connection', socket => { upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)); });
  upstream.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', data => socket.write(data));
  });
  await listen(upstream, { host: '127.0.0.1', port: 0 });
  const sessions = new Sessions();
  const manager = { process: { address: new URL(`http://127.0.0.1:${upstream.address().port}/#token=secret`) }, settingsDocument: '/vol1/1000/dsh-for-fnos/.dsh/settings.yaml', busy: null, status: async () => ({ current: '0.1.5-rc.1', running: true, busy: null, error: null }), dispatch: async () => {} };
  const gateway = createDshGateway(manager, sessions, 3080, '/* fnOS file-manager bridge */');
  await listen(gateway, { host: '127.0.0.1', port: 0 });
  const authority = `127.0.0.1:${gateway.address().port}`;
  const cookie = `fnos_dsh_3080=${sessions.exchange(sessions.ticket(authority, { settingsUrl: 'http://nas.local:5666/app/dsh-for-fnos/settings/' }), authority)}`;
  t.after(async () => { gateway.closeConnections(); for (const socket of upstreamSockets) socket.destroy(); gateway.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => upstream.close(r))]); });
  return { gateway, upstream, manager, sessions, authority, cookie, url: `http://${authority}` };
}
test('unauthenticated and cross-origin requests are rejected before reaching plugins', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/arbitrary-plugin/api`)).status, 401);
  assert.equal((await fetch(`${f.url}/api`, { headers: { cookie: f.cookie, origin: 'https://evil.example' } })).status, 401);
  const ticket = f.sessions.ticket(f.authority);
  assert.throws(() => f.sessions.exchange(ticket, 'other.example'));
  f.sessions.exchange(ticket, f.authority);
  assert.throws(() => f.sessions.exchange(ticket, f.authority));
});
test('the fragment-only bootstrap ticket works despite fnOS origin rewriting', async t => {
  const f = await fixture(t);
  const bootstrap = await fetch(`${f.url}/_fnos/bootstrap`);
  assert.equal(bootstrap.status, 200);
  assert.doesNotMatch(bootstrap.headers.get('content-security-policy') ?? '', /frame-ancestors/i);
  const ticket = f.sessions.ticket(f.authority);
  const response = await fetch(`${f.url}/_fnos/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://gateway.internal', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ ticket }),
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers.getSetCookie().some(value => value.startsWith('fnos_dsh_3080=')));
  assert.throws(() => f.sessions.exchange(ticket, f.authority));
});
test('plugin paths, query strings and binary request bodies survive unchanged', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 1, 2, 128, 255]);
  const response = await fetch(`${f.url}/third-party/api/path%20space?x=%2F&x=2`, { method: 'POST', body: bytes, headers: { cookie: f.cookie, origin: f.url, 'x-trim-userid': '123', 'x-forwarded-host': 'spoofed' } });
  const data = await response.json();
  assert.equal(data.url, '/third-party/api/path%20space?x=%2F&x=2');
  assert.equal(data.body, bytes.toString('base64'));
  assert.equal(data.headers.origin, `http://127.0.0.1:${f.upstream.address().port}`);
  assert.equal(data.headers['x-trim-userid'], undefined);
  assert.equal(data.headers['x-forwarded-host'], undefined);
  assert.equal(data.headers.cookie, undefined);
});
test('only the DSH root document receives the trusted-host bootstrap', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/`, { headers: { cookie: f.cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), null);
  assert.match(await response.text(), /<head><link rel="stylesheet" href="\/_fnos\/shell\.css\?v=1\.0\.0"><script src="\/_fnos\/owns-host\.js"><\/script>/);
  const script = await fetch(`${f.url}/_fnos/owns-host.js`);
  const scriptText = await script.text();
  assert.match(scriptText, /__FNOS_DSH_SETTINGS_FILE__="\/vol1\/1000\/dsh-for-fnos\/\.dsh\/settings.yaml"/);
  assert.match(scriptText, /fnOS file-manager bridge/);
});
test('the settings document action stays available for the fnOS file-manager bridge', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/api/settings/describe`, { method: 'POST', headers: { cookie: f.cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.value.hasDocument, true);
});

test('the DSH shell exposes authenticated status, restart, and settings navigation', async t => {
  const f = await fixture(t);
  const status = await fetch(`${f.url}/_fnos/status`, { headers: { cookie: f.cookie } });
  assert.deepEqual(await status.json(), { current: '0.1.5-rc.1', running: true, busy: null, error: null });
  const restart = await fetch(`${f.url}/_fnos/restart`, { method: 'POST', headers: { cookie: f.cookie } });
  assert.equal(restart.status, 202);
  const reopen = await fetch(`${f.url}/_fnos/reopen`, { headers: { cookie: f.cookie }, redirect: 'manual' });
  assert.equal(reopen.status, 303);
  assert.match(reopen.headers.get('location') ?? '', /^\/_fnos\/bootstrap#[A-Za-z0-9_-]+$/);
  const settings = await fetch(`${f.url}/_fnos/settings`, { headers: { cookie: f.cookie }, redirect: 'manual' });
  assert.equal(settings.status, 303);
  assert.equal(settings.headers.get('location'), 'http://nas.local:5666/app/dsh-for-fnos/settings/');
  const root = await fetch(`${f.url}/`, { headers: { cookie: f.cookie } });
  assert.match(await root.text(), /_fnos\/shell\.css\?v=1\.0\.0/);
  const shellResponse = await fetch(`${f.url}/_fnos/shell.js?v=1.0.0`);
  assert.equal(shellResponse.status, 200);
  const shell = await shellResponse.text();
  assert.match(shell, /重启 DSH/);
  assert.match(shell, /fnos-dsh-veil/);
  assert.match(shell, /data-role="state-text"/);
  assert.match(shell, /classList\.toggle\('is-admin'/);
  assert.match(shell, /M512\.085373 1024/);
  assert.match(shell, /location\.assign\('\/_fnos\/reopen'\)/);
  assert.match(shell, /运行中 · /);
  assert.doesNotMatch(shell, /title=/);
  assert.doesNotThrow(() => new Function(shell));
  const shellStyle = await fetch(`${f.url}/_fnos/shell.css?v=1.0.0`);
  const shellCss = await shellStyle.text();
  assert.match(shellCss, /fnos-dsh-spin/);
  assert.match(shellCss, /@media\(max-width:620px\)/);
  assert.match(shellCss, /transform:none/);
  assert.match(shellCss, /backdrop-filter:none/);
  assert.match(shellCss, /\[data-role=panel\][^{]*\{[^}]*width:288px/);
  assert.match(shellCss, /grid-template-columns:repeat\(3,1fr\)/);
  assert.match(shellCss, /bottom:calc\(8px \+ env\(safe-area-inset-bottom,0px\)\)/);
});
test('reopen waits for DSH readiness before minting a fresh navigation ticket', async t => {
  const f = await fixture(t);
  const address = f.manager.process.address;
  f.manager.busy = '重启 DSH';
  f.manager.process.address = null;
  setTimeout(() => { f.manager.process.address = address; f.manager.busy = null; }, 280);
  const started = Date.now();
  const response = await fetch(`${f.url}/_fnos/reopen`, { headers: { cookie: f.cookie }, redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.ok(Date.now() - started >= 240);
  assert.match(response.headers.get('location') ?? '', /^\/_fnos\/bootstrap#[A-Za-z0-9_-]+$/);
});
test('SSE sends the first chunk before the upstream finishes', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/plugin/events`, { headers: { cookie: f.cookie } });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: second\n\n');
  await reader.cancel();
});
test('arbitrary plugin upgrade routes are tunneled in both directions', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await new Promise((resolve, reject) => {
    const socket = net.connect(f.gateway.address().port, '127.0.0.1');
    let upgraded = false;
    socket.on('connect', () => socket.write(`GET /some-plugin/socket?x=1 HTTP/1.1\r\nHost: ${f.authority}\r\nOrigin: ${f.url}\r\nCookie: ${f.cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    socket.on('error', reject);
    socket.on('data', chunk => {
      if (!upgraded) { assert.match(chunk.toString(), /101 Switching Protocols/); upgraded = true; socket.write('test-frame'); }
      else { assert.equal(chunk.toString(), 'test-frame'); socket.destroy(); resolve(); }
    });
  });
});
