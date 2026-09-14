import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { serve, listen, PREFIX, DSH_PREFIX } from '../src/server/server.mjs';
import { rewriteHtml, rewriteCss } from '../src/server/subpath.mjs';

async function fixture(t) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.headers.cookie !== 'dsh_internal=fixture') { res.writeHead(401); return res.end(); }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      return res.end('<html><head><script src="/boot.js"></script><script>const userPath="/vol1/file";</script></head><body><img src="/plugin/icon.png"></body></html>');
    }
    if (req.url === '/style.css') { res.setHeader('content-type', 'text/css'); return res.end('a{background:url(/plugin/icon.png)}'); }
    if (req.url === '/boot.js') { res.setHeader('content-type', 'text/javascript'); return res.end('const p="/vol1/file";'); }
    if (req.url === '/redirect') { res.writeHead(303, { location: '/', 'set-cookie': 'upstream=fixture; Path=/' }); return res.end(); }
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      return setTimeout(() => res.end('data: second\n\n'), 200);
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.end(Buffer.concat(chunks));
  });
  const sockets = new Set();
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  upstream.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', data => socket.write(data));
  });
  await listen(upstream, { host: '127.0.0.1', port: 0 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-path-'));
  const socketPath = path.join(root, 'app.sock');
  const manager = {
    config: { port: 0 }, init: async () => {}, stop: async () => {}, dispatch: async () => {},
    status: async () => ({ running: true, current: 'fixture', busy: null }),
    process: { address: new URL(`http://127.0.0.1:${upstream.address().port}/`), authCookie: 'dsh_internal=fixture' },
  };
  const service = await serve({ root, socket: socketPath, manager });
  assert.equal(service.gateway, null, 'normal startup must not bind the legacy TCP port');
  t.after(async () => { await service.stop(); for (const socket of sockets) socket.destroy(); await new Promise(r => upstream.close(r)); await rm(root, { recursive: true, force: true }); });
  const admin = { host: 'gateway.internal', 'x-trim-userid': '1000', 'x-trim-isadmin': 'true' };
  const post = { ...admin, origin: 'https://nas.example:8080', 'x-fnos-request': '1', 'content-type': 'application/json' };
  function request(url, { headers = admin, method = 'GET', body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, path: url, headers, method }, res => {
        const chunks = []; res.on('data', x => chunks.push(x));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  return { seen, socketPath, request, admin, post };
}

test('Unix gateway launches on the HTTPS browser origin, adapts resources and isolates NAS credentials', async t => {
  const f = await fixture(t);
  const launch = await f.request(`${PREFIX}/api/launch`, { headers: f.post, method: 'POST', body: '{}' });
  assert.equal(JSON.parse(launch.body).url, `${DSH_PREFIX}/`);
  const page = await f.request(`${DSH_PREFIX}/`, { headers: { ...f.admin, cookie: 'nas_session=fixture', authorization: 'fixture' } });
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), new RegExp(`<head><script src="${DSH_PREFIX}/_fnos/subpath.js"`));
  assert.ok(page.body.toString().includes(`src="${DSH_PREFIX}/boot.js"`));
  assert.ok(page.body.toString().includes('const userPath="/vol1/file"'));
  assert.equal(f.seen.at(-1).headers.cookie, 'dsh_internal=fixture');
  assert.equal(f.seen.at(-1).headers.authorization, undefined);
  assert.equal(f.seen.at(-1).headers['x-trim-userid'], undefined);
  const bytes = Buffer.from([0, 255, 128, 1]);
  const echo = await f.request(`${DSH_PREFIX}/any-plugin/upload?x=%2F&x=2`, { headers: f.post, method: 'POST', body: bytes });
  assert.deepEqual(echo.body, bytes);
  assert.equal(f.seen.at(-1).url, '/any-plugin/upload?x=%2F&x=2');
  assert.equal((await f.request(`${DSH_PREFIX}/boot.js`)).body.toString(), 'const p="/vol1/file";');
  assert.ok((await f.request(`${DSH_PREFIX}/style.css`)).body.toString().includes(`url(${DSH_PREFIX}/plugin/icon.png)`));
  const redirect = await f.request(`${DSH_PREFIX}/redirect`);
  assert.equal(redirect.headers.location, `${DSH_PREFIX}/`);
  assert.equal(redirect.headers['set-cookie'], undefined);
  assert.equal((await f.request(`${DSH_PREFIX}/_fnos/settings`)).headers.location, `${PREFIX}/settings/`);
  assert.equal((await f.request(`${DSH_PREFIX}/_fnos/reopen`)).headers.location, `${DSH_PREFIX}/`);
  const shell = (await f.request(`${DSH_PREFIX}/_fnos/shell.js`)).body.toString();
  assert.ok(shell.includes(`location.assign('${DSH_PREFIX}/_fnos/settings')`));
  assert.doesNotThrow(() => new Function(shell));
});

test('Unix gateway rejects unprivileged, cross-site and unmarked mutation requests', async t => {
  const f = await fixture(t);
  for (const headers of [{}, { ...f.admin, 'x-trim-isadmin': 'false' }, { ...f.admin, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await f.request(`${DSH_PREFIX}/plugin`, { headers })).status, 403);
  }
  assert.equal((await f.request(`${DSH_PREFIX}/plugin`, { method: 'POST' })).status, 403);
  assert.equal(f.seen.length, 0);
});

test('Unix gateway streams SSE without waiting for completion', async t => {
  const f = await fixture(t);
  await new Promise((resolve, reject) => {
    const req = http.get({ socketPath: f.socketPath, path: `${DSH_PREFIX}/events`, headers: f.admin }, res => {
      assert.equal(res.headers['x-accel-buffering'], 'no');
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk.toString()));
      res.on('end', () => { assert.deepEqual(chunks, ['data: first\n\n', 'data: second\n\n']); resolve(); });
    });
    req.on('error', reject);
  });
});

test('Unix gateway validates browser WebSocket origin despite rewritten Host and tunnels plugin frames', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.request(`${PREFIX}/api/launch`, { headers: f.post, method: 'POST', body: '{}' });
  for (const origin of ['https://evil.example', f.post.origin]) {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(f.socketPath);
      let upgraded = false;
      socket.on('error', reject);
      socket.on('connect', () => socket.write(`GET ${DSH_PREFIX}/plugin/socket?x=1 HTTP/1.1\r\nHost: gateway.internal\r\nX-Trim-Userid: 1000\r\nX-Trim-Isadmin: true\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
      socket.on('data', chunk => {
        if (origin !== f.post.origin) { assert.match(chunk.toString(), /403/); socket.destroy(); resolve(); }
        else if (!upgraded) { assert.match(chunk.toString(), /101/); upgraded = true; socket.write('fixture-frame'); }
        else { assert.equal(chunk.toString(), 'fixture-frame'); socket.destroy(); resolve(); }
      });
    });
  }
  assert.equal(f.seen.at(-1).url, '/plugin/socket?x=1');
  assert.equal(f.seen.at(-1).headers.cookie, 'dsh_internal=fixture');
});

test('URL adapters preserve external URLs, inline scripts and user file paths', () => {
  const html = '<head><script>const p="/vol1/file";</script><link href="//cdn.example/a.css"><img src="/icon.svg"></head>';
  assert.equal(rewriteHtml(html, DSH_PREFIX), html.replace('src="/icon.svg"', `src="${DSH_PREFIX}/icon.svg"`));
  assert.equal(rewriteCss('a{background:url(https://cdn.example/a)}', DSH_PREFIX), 'a{background:url(https://cdn.example/a)}');
});

test('browser adapter maps fetch Request bodies, plugin script URLs, SSE and WebSocket URLs', async () => {
  const calls = [];
  class Element { setAttribute(name, value) { this[name] = value; } }
  class Script extends Element { set src(value) { this.value = value; } get src() { return this.value; } }
  class XHR { open(...args) { this.args = args; } send() {} setRequestHeader() {} }
  class Connection { constructor(url) { this.url = url; } }
  const context = vm.createContext({ URL, Request, Element, HTMLScriptElement: Script, XMLHttpRequest: XHR, WebSocket: Connection, EventSource: Connection,
    location: { href: `https://nas.example:8080${DSH_PREFIX}/`, origin: 'https://nas.example:8080', host: 'nas.example:8080' },
    document: { currentScript: { src: `https://nas.example:8080${DSH_PREFIX}/_fnos/subpath.js` } },
    history: { pushState() {}, replaceState() {} }, fetch: request => { calls.push(request); return Promise.resolve(); },
  });
  vm.runInContext(await readFile(new URL('../src/web/host/subpath.js', import.meta.url), 'utf8'), context);
  await vm.runInContext(`fetch(new Request('https://nas.example:8080/api/upload', { method: 'POST', body: 'fixture' }))`, context);
  assert.equal(calls[0].url, `https://nas.example:8080${DSH_PREFIX}/api/upload`);
  assert.equal(await calls[0].text(), 'fixture');
  assert.equal(calls[0].headers.get('x-fnos-request'), '1');
  assert.equal(vm.runInContext(`new WebSocket('wss://nas.example:8080/ws').url`, context), `wss://nas.example:8080${DSH_PREFIX}/ws`);
  assert.equal(vm.runInContext(`new EventSource('/events').url`, context), `https://nas.example:8080${DSH_PREFIX}/events`);
  assert.equal(vm.runInContext(`const el=new HTMLScriptElement(); el.src='/client/bundle.js'; el.src`, context), `https://nas.example:8080${DSH_PREFIX}/client/bundle.js`);
  await vm.runInContext(`fetch('https://external.example/api')`, context);
  assert.equal(calls[1].url, 'https://external.example/api');
  assert.equal(calls[1].headers.get('x-fnos-request'), null);
});
