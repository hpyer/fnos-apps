import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { extractGzip } from '../src/archive.mjs';
import { coreFlavor, elfArchitecture, expectedMachine, parseCoreVersion } from '../src/binary.mjs';

function elfBuffer(machine = 62, size = 4096) {
  const buffer = Buffer.alloc(size);
  buffer.write('\x7fELF', 0, 'binary');
  buffer[4] = 2;
  buffer[5] = 1;
  buffer.writeUInt16LE(machine, 18);
  return buffer;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clash-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('解压校验 SHA256、大小、gzip 完整性与 ELF 架构', async t => {
  const root = await workspace(t);
  const archive = path.join(root, 'core.gz');
  const payload = gzipSync(elfBuffer(62));
  await writeFile(archive, payload);
  const destination = path.join(root, 'mihomo');
  const result = await extractGzip(archive, destination, { expectedSha256: sha256(payload), expectedSize: payload.length, arch: 'x86_64' });
  assert.equal(result.size, 4096);
  assert.equal((await stat(destination)).mode & 0o777, 0o555);
  assert.equal(await elfArchitecture(destination), 'x86_64');
  assert.equal(await readFile(destination, 'hex'), elfBuffer(62).toString('hex'));
});

test('拒绝架构不符、哈希不符和损坏的压缩包', async t => {
  const root = await workspace(t);
  const archive = path.join(root, 'core.gz');
  const payload = gzipSync(elfBuffer(183));
  await writeFile(archive, payload);
  await assert.rejects(() => extractGzip(archive, path.join(root, 'a'), { arch: 'x86_64' }), /架构不匹配/);
  await assert.rejects(() => extractGzip(archive, path.join(root, 'b'), { expectedSha256: 'a'.repeat(64) }), /SHA256/);
  await assert.rejects(() => extractGzip(archive, path.join(root, 'c'), { expectedSize: 1 }), /大小/);
  await writeFile(archive, 'not gzip data');
  await assert.rejects(() => extractGzip(archive, path.join(root, 'd')), /解压失败/);
  assert.equal(expectedMachine('arm64'), 183);
  assert.equal(await elfArchitecture(path.join(root, 'd')) , null);
});

test('解析 mihomo 版本输出与分支标识', () => {
  assert.equal(parseCoreVersion('Mihomo Meta v1.19.33 linux amd64'), '1.19.33');
  assert.equal(parseCoreVersion('Clash Meta v1.18.0'), '1.18.0');
  assert.equal(parseCoreVersion('no version here'), '');
  assert.equal(coreFlavor('Mihomo Meta v1.19.33'), 'MetaCubeX');
  assert.equal(coreFlavor('mihomo smart-alpha v1.19.30'), 'Smart');
  assert.equal(coreFlavor('unknown build'), '');
});
