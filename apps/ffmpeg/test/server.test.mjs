import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve, PREFIX } from '../src/server.mjs';

function socketRequest(socket, pathname, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socket, path: PREFIX + pathname, method, headers }, response => {
      let data = ''; response.on('data', part => { data += part; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: data }));
    });
    request.on('error', reject); request.end(body);
  });
}
test('Unix Socket 限制权限，所有页面和操作仅允许网关注入的管理员身份', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-socket-')), socket = path.join(directory, 'app.sock');
  let calls = 0;
  const manager = { status: async () => ({ active: '' }), start: (action, id) => { calls++; return { action, id }; } };
  const service = await serve(manager, { assets: new URL('../src/web/', import.meta.url), socket });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await stat(socket)).mode & 0o777, 0o660);
  assert.equal((await socketRequest(socket, '/')).status, 403);
  const admin = { 'x-trim-userid': '1000', 'x-trim-isadmin': 'true' };
  assert.equal((await socketRequest(socket, '/api/status', { headers: { ...admin, 'x-trim-isadmin': 'false' } })).status, 403);
  const read = await socketRequest(socket, '/api/status', { headers: admin });
  assert.equal(read.status, 200); assert.equal(JSON.parse(read.text).active, '');
  const post = { method: 'POST', body: JSON.stringify({ id: 'one', url: 'https://example.com' }), headers: { ...admin, 'content-type': 'application/json' } };
  assert.equal((await socketRequest(socket, '/api/version/install', post)).status, 403);
  post.headers['x-fnos-request'] = '1'; post.headers['sec-fetch-site'] = 'cross-site';
  assert.equal((await socketRequest(socket, '/api/version/install', post)).status, 403);
  delete post.headers['sec-fetch-site'];
  const result = await socketRequest(socket, '/api/version/install', post);
  assert.equal(result.status, 202); assert.deepEqual(JSON.parse(result.text), { action: 'install', id: 'one' });
  assert.equal(calls, 1);
  for (const enabled of [true, false]) {
    const toggled = await socketRequest(socket, '/api/component/ffprobe', { ...post, body: JSON.stringify({ enabled }) });
    assert.equal(toggled.status, 202); assert.deepEqual(JSON.parse(toggled.text), { action: 'probe', id: enabled });
  }
  assert.equal(calls, 3);
  const page = await socketRequest(socket, '/', { headers: admin });
  assert.equal(page.status, 200); assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.equal((await socketRequest(socket, '/api/version/unknown', post)).status, 404);
});
test('开发服务仅接受预期 Host，错误请求不能启动版本操作', async t => {
  let calls = 0;
  const service = await serve({ check: async () => { calls++; return { available: [] }; } }, { assets: new URL('../src/web/', import.meta.url), devPort: 0 });
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}${PREFIX}`;
  const unexpectedHost = await new Promise((resolve, reject) => {
    const request = http.get(base + '/', { headers: { host: 'evil.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.once('error', reject);
  });
  assert.equal(unexpectedHost, 403);
  assert.equal((await fetch(base + '/api/version/check', { method: 'POST', headers: { 'x-fnos-request': '1', 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/api/version/check', { method: 'POST', headers: { 'x-fnos-request': '1', 'content-type': 'application/json' }, body: '{' })).status, 400);
  const checked = await fetch(base + '/api/version/check', { method: 'POST', headers: { 'x-fnos-request': '1', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(checked.status, 200); assert.equal(calls, 1);
});
