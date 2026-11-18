import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJSON, atomicWrite, hashFile, readJSON, safeId } from '../src/storage.mjs';
import { maskUrl, redact } from '../src/redact.mjs';

test('原子写入使用私有权限，JSON 可回读', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clash-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  await atomicJSON(file, { a: 1, secret: 'x' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readJSON(file), { a: 1, secret: 'x' });
  assert.deepEqual(await readJSON(path.join(root, 'missing.json'), { fallback: true }), { fallback: true });
  assert.equal(await readJSON(path.join(root, 'missing.json')), null);
  await atomicWrite(path.join(root, 'plain.txt'), 'hello');
  assert.equal(await readFile(path.join(root, 'plain.txt'), 'utf8'), 'hello');
});

test('标识符与哈希校验', async t => {
  assert.equal(safeId('installed-v1.19.33-x86_64'), 'installed-v1.19.33-x86_64');
  assert.throws(() => safeId('../etc/passwd'), /无效/);
  assert.throws(() => safeId('a/b'), /无效/);
  assert.throws(() => safeId(''), /无效/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'clash-hash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'x');
  await atomicWrite(file, 'abc');
  assert.equal(await hashFile(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('日志脱敏与订阅地址掩码', () => {
  const secrets = ['supersecretvalue'];
  const text = 'secret: abcdef1234\nurl=https://example.com/sub?token=abcdef123&x=1\npassword: hunter2\nAuthorization: Bearer token123\nsupersecretvalue';
  const result = redact(text, secrets);
  assert.ok(!result.includes('abcdef1234'));
  assert.ok(!result.includes('abcdef123'));
  assert.ok(!result.includes('hunter2'));
  assert.ok(!result.includes('Bearer token123'));
  assert.ok(!result.includes('supersecretvalue'));
  assert.equal(maskUrl('https://sub.example.com/api/sub?token=abc'), 'https://sub.example.com/api/sub?***');
  assert.equal(maskUrl('https://sub.example.com/yaml'), 'https://sub.example.com/yaml');
  assert.equal(maskUrl('not a url'), '***');
});
