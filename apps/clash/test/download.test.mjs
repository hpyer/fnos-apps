import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadText, downloadVerified } from '../src/download.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clash-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('校验 SHA256 与大小后落盘', async t => {
  const root = await workspace(t);
  const payload = Buffer.from('verified payload');
  const destination = path.join(root, 'core.gz');
  const progress = [];
  await downloadVerified({
    url: 'https://example.com/core.gz', destination, sha256: sha256(payload), size: payload.length,
    request: async () => new Response(payload, { status: 200 }), progress: (received, total) => progress.push([received, total]),
  });
  assert.deepEqual(await readFile(destination), payload);
  assert.deepEqual(progress.at(-1), [payload.length, payload.length]);
});

test('哈希或大小不符时删除文件并报错', async t => {
  const root = await workspace(t);
  const payload = Buffer.from('verified payload');
  const destination = path.join(root, 'core.gz');
  await assert.rejects(() => downloadVerified({
    url: 'https://example.com/core.gz', destination, sha256: 'a'.repeat(64), size: payload.length,
    request: async () => new Response(payload, { status: 200 }), retryBaseMs: 1,
  }), /SHA256/);
  await assert.rejects(() => readFile(destination), { code: 'ENOENT' });
  await assert.rejects(() => downloadVerified({
    url: 'https://example.com/core.gz', destination, sha256: sha256(payload), size: payload.length + 1,
    request: async () => new Response(payload, { status: 200 }), retryBaseMs: 1,
  }), /大小/);
});

test('HTTP 错误与元数据校验', async t => {
  const root = await workspace(t);
  const destination = path.join(root, 'core.gz');
  await assert.rejects(() => downloadVerified({
    url: 'https://example.com/core.gz', destination, sha256: 'a'.repeat(64), size: 10,
    request: async () => new Response('nope', { status: 404 }), retryBaseMs: 1,
  }), /HTTP 404/);
  await assert.rejects(() => downloadVerified({ url: '', destination, sha256: 'bad', size: 10, request: async () => new Response('') }), /元数据无效/);
});

test('订阅文本下载限制大小并返回元数据', async t => {
  await workspace(t);
  const text = 'mixed-port: 7890\nmode: rule\n';
  const result = await downloadText({
    url: 'https://example.com/sub', maxBytes: 1024,
    request: async () => new Response(text, { status: 200, headers: { etag: '"v1"' } }),
  });
  assert.equal(result.text, text);
  assert.equal(result.size, Buffer.byteLength(text));
  assert.equal(result.etag, '"v1"');
  await assert.rejects(() => downloadText({
    url: 'https://example.com/sub', maxBytes: 4,
    request: async () => new Response(text, { status: 200 }),
  }), /限制/);
  await assert.rejects(() => downloadText({
    url: 'https://example.com/sub', maxBytes: 1024,
    request: async () => new Response('', { status: 500 }),
  }), /HTTP 500/);
});
