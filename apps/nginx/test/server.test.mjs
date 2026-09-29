import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../src/server.mjs';

test('管理 Unix Socket 只允许 root 连接，避免 Nginx worker 伪造网关身份', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fnos-nginx-socket-'));
  const socket = path.join(directory, 'app.sock');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await serve({}, { assets: new URL('../src/web/', import.meta.url), socket });
  try {
    assert.equal((await stat(socket)).mode & 0o777, 0o600);
  } finally { await service.close(); }
});

test('管理员可读取主配置并提交候选内容', async t => {
  let saved;
  const manager = {
    readConfig: async () => 'events { worker_connections 1024; }\n',
    saveConfig: async source => { saved = source; return { ok: true }; }
  };
  const service = await serve(manager, { assets: new URL('../src/web/', import.meta.url), devPort: 0 });
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.server.address().port}/app/nginx-for-fnos/api/config`;
  const read = await fetch(base);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { source: 'events { worker_connections 1024; }\n' });
  const denied = await fetch(`${base}/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'new' }) });
  assert.equal(denied.status, 403);
  const write = await fetch(`${base}/save`, { method: 'POST', headers: { 'x-fnos-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ source: 'new' }) });
  assert.equal(write.status, 200);
  assert.deepEqual(await write.json(), { ok: true });
  assert.equal(saved, 'new');
});

test('管理员可切换站点状态', async t => {
  let request;
  const manager = { setSiteEnabled: async (name, enabled) => { request = { name, enabled }; return { ok: true, enabled }; } };
  const service = await serve(manager, { assets: new URL('../src/web/', import.meta.url), devPort: 0 });
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.server.address().port}/app/nginx-for-fnos/api/site/enabled`;
  const response = await fetch(url, { method: 'POST', headers: { 'x-fnos-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'example.conf', enabled: false }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, enabled: false });
  assert.deepEqual(request, { name: 'example.conf', enabled: false });
});
