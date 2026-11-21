import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PREFIX, serve } from '../src/server.mjs';

const ADMIN = { 'x-trim-userid': '1000', 'x-trim-isadmin': 'true' };

function socketRequest(socket, pathname, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socket, path: PREFIX + pathname, method, headers }, response => {
      let data = '';
      response.on('data', part => { data += part; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: data }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function createManager() {
  const calls = [];
  const manager = { calls, running: false };
  manager.status = () => ({ running: manager.running, pid: 0, startedAt: 0, lastError: '', settings: { listenAddresses: ['127.0.0.1'], upstreams: ['8.8.8.8'], cacheSize: 1000, queryLogging: false, autoStart: false }, records: [], platformSupported: true, localAddresses: [] });
  manager.config = async () => ({ source: 'server=8.8.8.8', path: '/tmp/dnsmasq.conf' });
  manager.diagnostics = async () => ({ running: manager.running, binary: '/missing/dnsmasq' });
  manager.saveSettings = async input => { calls.push(['saveSettings', input]); return manager.status(); };
  manager.saveRecords = async records => { calls.push(['saveRecords', records]); return manager.status(); };
  manager.deleteRecord = async index => { calls.push(['deleteRecord', index]); manager.running = true; return manager.status(); };
  manager.validateConfig = async () => ({ valid: true });
  manager.start = async () => { calls.push(['start']); manager.running = true; return manager.status(); };
  manager.stop = async () => { calls.push(['stop']); manager.running = false; return manager.status(); };
  manager.restart = async () => { calls.push(['restart']); return manager.status(); };
  return manager;
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fnos-dnsmasq-socket-'));
  const socket = path.join(directory, 'app.sock');
  const manager = createManager();
  const service = await serve(manager, { assets: new URL('../src/web/', import.meta.url), socket, ...options });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { socket, manager };
}

test('socket 模式只接受飞牛网关注入的管理员身份', async t => {
  // 打包运行时只监听 Unix socket；即便调用方误传 devPort 也必须使用网关请求头校验，
  // 否则 fnOS 网关转发的所有请求都会被当成「仅限飞牛管理员访问」。
  const { socket } = await fixture(t, { devPort: 3084 });
  assert.equal((await stat(socket)).mode & 0o777, 0o660);
  assert.equal((await socketRequest(socket, '/')).status, 403);
  assert.equal((await socketRequest(socket, '/api/status')).status, 403);
  assert.equal((await socketRequest(socket, '/api/status', { headers: { ...ADMIN, 'x-trim-isadmin': 'false' } })).status, 403);
  assert.equal((await socketRequest(socket, '/api/status', { headers: { ...ADMIN, 'x-trim-userid': 'abc' } })).status, 403);
  assert.equal((await socketRequest(socket, '/api/status', { headers: { ...ADMIN, 'sec-fetch-site': 'cross-site' } })).status, 403);

  const page = await socketRequest(socket, '/', { headers: ADMIN });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.text, /DNS 服务/);
  // 页面必须自己引用样式与脚本；漏掉样式表会让应用在真机上以无样式 HTML 呈现。
  assert.match(page.text, /<link rel="stylesheet" href="\.\/index\.css">/);
  assert.match(page.text, /<script[^>]*src="\.\/index\.js"/);
  const status = await socketRequest(socket, '/api/status', { headers: ADMIN });
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.text).running, false);
});

test('样式与脚本以正确的 MIME 类型返回且非空', async t => {
  const { socket } = await fixture(t);
  for (const [asset, type, marker] of [['/index.css', /text\/css/, /\.card/], ['/index.js', /javascript/, /function/]]) {
    const response = await socketRequest(socket, asset, { headers: ADMIN });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], type);
    assert.match(response.text, marker);
    assert.match(response.headers['content-security-policy'], /style-src 'self'/);
  }
});

test('socket 模式下管理接口按 x-fnos-request 与 JSON 校验', async t => {
  const { socket, manager } = await fixture(t);
  const post = { method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json', 'x-fnos-request': '1' } };
  assert.equal((await socketRequest(socket, '/api/service/start', { ...post, headers: { ...ADMIN, 'content-type': 'application/json' } })).status, 403);
  assert.equal((await socketRequest(socket, '/api/service/start', { ...post, headers: { ...post.headers, 'content-type': 'text/plain' } })).status, 415);
  const started = await socketRequest(socket, '/api/service/start', post);
  assert.equal(started.status, 200);
  assert.equal(JSON.parse(started.text).running, true);
  assert.deepEqual(manager.calls.at(-1), ['start']);
});

test('开发端口模式按 Host 校验且不信任网关请求头', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fnos-dnsmasq-port-'));
  const service = await serve(createManager(), { assets: new URL('../src/web/', import.meta.url), devPort: 0 });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { port } = service.server.address();
  const request = (pathname, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: PREFIX + pathname, headers }, response => {
      let data = '';
      response.on('data', part => { data += part; });
      response.on('end', () => resolve({ status: response.statusCode, text: data }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal((await request('/api/status')).status, 200);
  assert.equal((await request('/api/status', { host: 'gateway.internal', ...ADMIN })).status, 403);
});
