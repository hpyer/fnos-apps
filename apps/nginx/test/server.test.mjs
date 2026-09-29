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
