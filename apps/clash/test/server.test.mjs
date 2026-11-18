import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { LogHub } from '../src/log-hub.mjs';
import { PREFIX, serve } from '../src/server.mjs';

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
  const manager = new EventEmitter();
  const calls = [];
  manager.calls = calls;
  manager.logs = new LogHub();
  manager.traffic = { up: 1, down: 2, at: Date.now() };
  manager.log = () => {};
  manager.status = async () => ({ core: { state: 'running' }, version: '0.1.0' });
  manager.preparationSnapshot = () => ({ active: false, label: '', steps: [] });
  manager.readConfig = async () => ({ source: 'mixed-port: 7890', kind: 'manual' });
  manager.listBackups = async () => [{ id: '2026-01-01T00-00-00-000Z-manual.yaml', label: 'x', size: 10 }];
  manager.diagnostics = async () => ({ core: { running: true }, hints: ['测试提示'], network: { addresses: [], checks: [] } });
  manager.logsHistory = () => [{ seq: 1, at: new Date().toISOString(), level: 'info', source: 'app', message: 'hello log' }];
  manager.proxies = async () => ({ groups: [], proxies: {} });
  manager.connections = async () => ({ connections: [], uploadTotal: 0, downloadTotal: 0 });
  const record = name => async input => { calls.push([name, input]); return { ok: true, name }; };
  manager.saveConfig = async source => { calls.push(['saveConfig', source]); return { ok: true }; };
  manager.validateConfig = record('validateConfig');
  manager.restoreBackup = record('restoreBackup');
  manager.setSettings = async (input, options) => { calls.push(['setSettings', input, options]); return { ok: true }; };
  manager.startCore = record('startCore');
  manager.stopCore = record('stopCore');
  manager.restartCore = record('restartCore');
  manager.checkCores = record('checkCores');
  manager.startJob = async (action, id) => { calls.push(['startJob', action, id]); return { job: { state: 'running', action, id } }; };
  manager.setMode = record('setMode');
  manager.addSubscription = record('addSubscription');
  manager.updateSubscriptionSettings = record('updateSubscriptionSettings');
  manager.deleteSubscription = record('deleteSubscription');
  manager.updateSubscription = record('updateSubscription');
  manager.applySubscription = record('applySubscription');
  manager.previewSubscription = record('previewSubscription');
  manager.selectProxy = record('selectProxy');
  manager.delay = record('delay');
  manager.groupDelay = record('groupDelay');
  manager.delayAll = async () => ({ groups: { Proxy: { A: 1 } }, tested: 1 });
  manager.deleteBackup = async id => ({ ok: true, id });
  manager.setSystemProxy = async enabled => ({ enabled });
  manager.setTun = async enabled => ({ enabled });
  manager.refreshProvider = async name => ({ name });
  manager.closeConnection = record('closeConnection');
  manager.closeAllConnections = record('closeAllConnections');
  return manager;
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clash-socket-'));
  const socket = path.join(directory, 'app.sock');
  const manager = createManager();
  let credentialKey = '';
  const service = await serve(manager, {
    assets: new URL('../src/web/', import.meta.url), socket,
    getCredentialKey: () => credentialKey,
    setCredentialKey: value => { credentialKey = value; },
  });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { socket, manager };
}

const ADMIN = { 'x-trim-userid': '1000', 'x-trim-isadmin': 'true' };
const POST = { method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json', 'x-fnos-request': '1' } };

test('Unix Socket 权限与管理员校验', async t => {
  const { socket } = await fixture(t);
  assert.equal((await stat(socket)).mode & 0o777, 0o660);
  assert.equal((await socketRequest(socket, '/')).status, 403);
  assert.equal((await socketRequest(socket, '/api/status', { headers: { ...ADMIN, 'x-trim-isadmin': 'false' } })).status, 403);
  assert.equal((await socketRequest(socket, '/api/status', { headers: { ...ADMIN, 'x-trim-userid': 'abc' } })).status, 403);
  assert.equal((await socketRequest(socket, '/api/status', { headers: { ...ADMIN, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await socketRequest(socket, '/api/status', { headers: ADMIN })).status, 200);
});

test('加密凭据通道解密密码并提交给管理服务', async t => {
  const { socket, manager } = await fixture(t);
  const keyResponse = await socketRequest(socket, '/api/credential-key', { headers: ADMIN });
  assert.equal(keyResponse.status, 200);
  const publicKey = JSON.parse(JSON.parse(keyResponse.text).publicKey);

  const point = Buffer.alloc(65);
  point[0] = 0x04;
  Buffer.from(publicKey.x, 'base64url').copy(point, 1);
  Buffer.from(publicKey.y, 'base64url').copy(point, 33);

  const encrypt = password => {
    const client = crypto.createECDH('prime256v1');
    client.generateKeys();
    const shared = client.computeSecret(point);
    const aesKey = crypto.hkdfSync('sha256', shared, Buffer.alloc(32), Buffer.alloc(0), 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(aesKey), iv);
    const data = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return {
      ephemeralPublicKey: client.getPublicKey().toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
  };
  // Compressed 33-byte ephemeral points must also be accepted (noble defaults to compressed).
  const compressed = encrypt('compressed-pass');
  compressed.ephemeralPublicKey = Buffer.from(
    crypto.ECDH.convertKey(Buffer.from(compressed.ephemeralPublicKey, 'base64'), 'prime256v1', undefined, undefined, 'compressed'),
  ).toString('base64');
  for (const [encryptedCredential, password] of [[encrypt('secret-pass'), 'secret-pass'], [compressed, 'compressed-pass']]) {
    const response = await socketRequest(socket, '/api/settings/save', {
      ...POST,
      body: JSON.stringify({ encryptedCredential, autoStart: true }),
    });
    assert.equal(response.status, 200);
    const call = manager.calls.filter(item => item[0] === 'setSettings').at(-1);
    assert.equal(call[2].password, password);
  }
});

test('静态页面与安全响应头', async t => {
  const { socket } = await fixture(t);
  const page = await socketRequest(socket, '/', { headers: ADMIN });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.text, /Clash for fnOS/);
  const script = await socketRequest(socket, '/index.js', { headers: ADMIN });
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /javascript/);
  assert.equal((await socketRequest(socket, '/../manifest', { headers: ADMIN })).status, 404);
  assert.equal((await socketRequest(socket, '/manifest', { headers: ADMIN })).status, 404);
});

test('GET 接口返回状态、配置、日志与流量流', async t => {
  const { socket, manager } = await fixture(t);
  assert.equal((await socketRequest(socket, '/api/status', { headers: ADMIN })).status, 200);
  assert.match((await socketRequest(socket, '/api/config', { headers: ADMIN })).text, /mixed-port/);
  const preparation = await socketRequest(socket, '/api/preparation', { headers: ADMIN });
  assert.equal(preparation.status, 200);
  assert.equal(JSON.parse(preparation.text).preparation.active, false);
  assert.equal((await socketRequest(socket, '/api/backups', { headers: ADMIN })).status, 200);
  assert.equal((await socketRequest(socket, '/api/logs?limit=10', { headers: ADMIN })).status, 200);
  const diagnostics = await socketRequest(socket, '/api/diagnostics', { headers: ADMIN });
  assert.equal(diagnostics.status, 200);
  assert.match(diagnostics.text, /测试提示/);

  const received = await new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socket, path: `${PREFIX}/api/logs/stream`, headers: ADMIN }, response => {
      let data = '';
      response.on('data', chunk => {
        data += chunk;
        if (data.includes('hello log')) { request.destroy(); resolve(data); }
      });
    });
    request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    request.end();
    setTimeout(() => resolve(''), 3000);
  });
  assert.match(received, /hello log/);

  const traffic = await new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socket, path: `${PREFIX}/api/traffic/stream`, headers: ADMIN }, response => {
      let data = '';
      response.on('data', chunk => {
        data += chunk;
        if (data.includes('"down":222')) { request.destroy(); resolve(data); }
      });
    });
    request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    request.end();
    setTimeout(() => manager.emit('traffic', { up: 111, down: 222, at: Date.now() }), 100);
    setTimeout(() => resolve(''), 3000);
  });
  assert.match(traffic, /"up":111/);
});

test('POST 接口要求 JSON、自定义头并正确分发操作', async t => {
  const { socket, manager } = await fixture(t);
  const body = JSON.stringify({ source: 'mixed-port: 7890' });
  assert.equal((await socketRequest(socket, '/api/config/save', { method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body })).status, 403);
  assert.equal((await socketRequest(socket, '/api/config/save', { method: 'POST', headers: { ...ADMIN, 'content-type': 'text/plain', 'x-fnos-request': '1' }, body })).status, 415);
  const saved = await socketRequest(socket, '/api/config/save', { ...POST, body });
  assert.equal(saved.status, 200);
  assert.deepEqual(manager.calls.at(-1), ['saveConfig', 'mixed-port: 7890']);

  assert.equal((await socketRequest(socket, '/api/core/start', { ...POST, body: '{}' })).status, 200);
  assert.equal((await socketRequest(socket, '/api/core/check', { ...POST, body: JSON.stringify({ channel: 'metacubex-stable' }) })).status, 200);
  const job = await socketRequest(socket, '/api/core/install', { ...POST, body: JSON.stringify({ id: 'metacubex-stable-v1.19.33-x86_64' }) });
  assert.equal(job.status, 202);
  assert.deepEqual(JSON.parse(job.text).job.id, 'metacubex-stable-v1.19.33-x86_64');
  assert.equal((await socketRequest(socket, '/api/mode/set', { ...POST, body: JSON.stringify({ mode: 'global' }) })).status, 200);
  assert.equal((await socketRequest(socket, '/api/subscription/add', { ...POST, body: JSON.stringify({ name: 'n', url: 'https://a.example/x' }) })).status, 200);
  assert.equal((await socketRequest(socket, '/api/proxy/delay-all', { ...POST, body: '{}' })).status, 200);
  assert.equal((await socketRequest(socket, '/api/config/backup/delete', { ...POST, body: JSON.stringify({ id: 'x.yaml' }) })).status, 200);
  assert.equal((await socketRequest(socket, '/api/settings/system-proxy', { ...POST, body: JSON.stringify({ enabled: true }) })).status, 200);
  assert.equal((await socketRequest(socket, '/api/settings/tun', { ...POST, body: JSON.stringify({ enabled: true }) })).status, 200);
  assert.equal((await socketRequest(socket, '/api/proxy/provider/refresh', { ...POST, body: JSON.stringify({ name: 'airport' }) })).status, 200);
  assert.equal((await socketRequest(socket, '/api/connection/close-all', { ...POST, body: '{}' })).status, 200);
  assert.equal((await socketRequest(socket, '/api/unknown', { ...POST, body: '{}' })).status, 404);
  assert.equal((await socketRequest(socket, '/api/config/save', { ...POST, body: '{' })).status, 400);
});

test('请求体限制与开发模式 Host 校验', async t => {
  const { socket } = await fixture(t);
  const huge = JSON.stringify({ source: 'x'.repeat(3 * 1024 * 1024 + 100) });
  assert.equal((await socketRequest(socket, '/api/config/save', { ...POST, body: huge })).status, 413);

  const service = await serve(createManager(), { assets: new URL('../src/web/', import.meta.url), devPort: 0 });
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}${PREFIX}`;
  const denied = await new Promise((resolve, reject) => {
    http.get(`${base}/`, { headers: { host: 'evil.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject);
  });
  assert.equal(denied, 403);
  assert.equal((await fetch(`${base}/api/status`)).status, 200);
  assert.equal((await fetch(`${base}/api/config/save`, { method: 'POST', headers: { 'x-fnos-request': '1', 'content-type': 'application/json' }, body: '{}' })).status, 200);
});
