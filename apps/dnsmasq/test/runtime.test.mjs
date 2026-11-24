import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureEmbeddedDnsmasq, loadLock } from '../scripts/runtime.mjs';

const BASE = 'https://github.com/hpyer/fnos-apps/releases/download/dnsmasq-runtime-2.93';

function elf(machine, size = 64) {
  const buffer = Buffer.alloc(size);
  buffer[0] = 0x7f; buffer[1] = 0x45; buffer[2] = 0x4c; buffer[3] = 0x46;
  buffer[4] = 2; buffer[5] = 1;
  buffer.writeUInt16LE(machine, 18);
  return buffer;
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    const body = responses.get(String(url));
    if (!body) return { ok: false, status: 404, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(body.length) }),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
  };
  return { fetchImpl, calls };
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fnos-dnsmasq-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const x64 = overrides.x64 || elf(62);
  const arm = overrides.arm || elf(183);
  const license = overrides.license || Buffer.from('GPL-2.0-or-later\n');
  const lock = {
    schema: 1,
    version: '2.93',
    source: 'https://thekelleys.org.uk/dnsmasq/dnsmasq-2.93.tar.xz',
    sourceSha256: '0c00d4e5c97c8306e5fb932b348b34269c9c29a0e7df0e8e82958b407092bc19',
    license: 'GPL-2.0-or-later',
    licenseFile: { url: `${BASE}/COPYING-dnsmasq-2.93`, sha256: digest(license), size: license.length },
    assets: {
      x86_64: { url: `${BASE}/dnsmasq-2.93-debian12-x86_64`, sha256: digest(x64), size: x64.length, elfMachine: 62 },
      arm64: { url: `${BASE}/dnsmasq-2.93-debian12-arm64`, sha256: digest(arm), size: arm.length, elfMachine: 183 },
    },
  };
  const lockPath = path.join(directory, 'core-versions.lock');
  await writeFile(lockPath, JSON.stringify(lock));
  const network = fakeFetch(new Map([[lock.licenseFile.url, license], [lock.assets.x86_64.url, x64], [lock.assets.arm64.url, arm]]));
  return { directory, lock, lockPath, cacheDir: path.join(directory, 'cache'), x64, license, ...network };
}

test('downloads and caches a verified runtime for the target architecture', async t => {
  const { lockPath, cacheDir, x64, license, fetchImpl, calls } = await fixture(t);
  const first = await ensureEmbeddedDnsmasq({ arch: 'x64', lockPath, cacheDir, fetchImpl, log: () => {} });
  assert.equal(first.version, '2.93');
  assert.equal(first.arch, 'x86_64');
  assert.deepEqual(await readFile(first.binary), x64);
  assert.deepEqual(await readFile(first.license), license);
  assert.equal(calls.length, 2);
  const second = await ensureEmbeddedDnsmasq({ arch: 'x64', lockPath, cacheDir, fetchImpl: async () => { throw Error('网络不应被再次访问'); }, log: () => {} });
  assert.equal(second.binary, first.binary);
});

test('builds the arm64 runtime from its own locked asset', async t => {
  const { lockPath, cacheDir, fetchImpl } = await fixture(t);
  const runtime = await ensureEmbeddedDnsmasq({ arch: 'arm64', lockPath, cacheDir, fetchImpl, log: () => {} });
  assert.equal(runtime.arch, 'arm64');
  assert.equal((await readFile(runtime.binary)).readUInt16LE(18), 183);
});

test('rejects a download whose SHA-256 or architecture does not match the lock', async t => {
  const { lock, license, lockPath, cacheDir } = await fixture(t);
  const tampered = Buffer.from(elf(62));
  tampered[40] ^= 0xff;
  const wrongHash = fakeFetch(new Map([[lock.licenseFile.url, license], [lock.assets.x86_64.url, tampered]]));
  await assert.rejects(() => ensureEmbeddedDnsmasq({ arch: 'x64', lockPath, cacheDir, fetchImpl: wrongHash.fetchImpl, log: () => {} }), /SHA-256/);
  assert.equal(await stat(path.join(cacheDir, '2.93', 'x86_64', 'dnsmasq')).catch(() => null), null);

  const wrongMachine = elf(183);
  const wrongMachineLock = {
    ...lock,
    assets: { ...lock.assets, x86_64: { ...lock.assets.x86_64, sha256: digest(wrongMachine), size: wrongMachine.length } },
  };
  await writeFile(lockPath, JSON.stringify(wrongMachineLock));
  const server = fakeFetch(new Map([[lock.licenseFile.url, license], [lock.assets.x86_64.url, wrongMachine]]));
  await assert.rejects(() => ensureEmbeddedDnsmasq({ arch: 'x64', lockPath, cacheDir, fetchImpl: server.fetchImpl, log: () => {} }), /目标架构/);
});

test('verifies an explicit DNSMASQ_BINARY against the lock', async t => {
  const { directory, lockPath, cacheDir, x64, fetchImpl } = await fixture(t);
  const supplied = path.join(directory, 'custom-dnsmasq');
  await writeFile(supplied, x64);
  const runtime = await ensureEmbeddedDnsmasq({ arch: 'x64', binary: supplied, lockPath, cacheDir, fetchImpl, log: () => {} });
  assert.equal(runtime.binary, supplied);
  await writeFile(supplied, elf(62, 128));
  await assert.rejects(() => ensureEmbeddedDnsmasq({ arch: 'x64', binary: supplied, lockPath, cacheDir, fetchImpl, log: () => {} }), /DNSMASQ_BINARY/);
});

test('rejects an incomplete lock file', async t => {
  const { lockPath } = await fixture(t);
  const broken = JSON.parse(await readFile(lockPath, 'utf8'));
  delete broken.assets.arm64;
  await writeFile(lockPath, JSON.stringify(broken));
  await assert.rejects(() => loadLock(lockPath), /arm64/);
});
