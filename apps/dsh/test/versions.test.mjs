import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, loadConfig, validateConfig, writeJson } from '../src/shared/config.mjs';
import { Versions, PACKAGE, exactVersion } from '../src/runtime/versions.mjs';

test('configuration always checks latest and validates unprivileged ports', () => {
  assert.equal(DEFAULTS.registry, 'https://mirrors.cloud.tencent.com/npm');
  assert.equal(DEFAULTS.idleTimeoutSeconds, 600);
  assert.deepEqual(validateConfig({ ...DEFAULTS, channels: ['beta', 'beta'] }).channels, ['latest', 'beta']);
  for (const port of [0, 80, 65536, 3080.2, 'abc']) assert.throws(() => validateConfig({ ...DEFAULTS, port }));
  assert.throws(() => validateConfig({ ...DEFAULTS, channels: ['nightly'] }));
  assert.throws(() => validateConfig({ ...DEFAULTS, registry: 'https://user:password@example.org' }));
  assert.equal(validateConfig({ ...DEFAULTS, publicHost: 'NAS.Local' }).publicHost, 'nas.local');
  assert.equal(validateConfig({ ...DEFAULTS, publicHost: '[2001:db8::1]' }).publicHost, '[2001:db8::1]');
  for (const host of ['https://nas.local', 'nas.local:3080', 'nas.local/path', 'user@nas.local', 'localhost', '127.0.0.1', '[::1]', '']) {
    if (host) assert.throws(() => validateConfig({ ...DEFAULTS, publicHost: host }));
  }
  assert.equal(validateConfig({ ...DEFAULTS, idleTimeoutSeconds: 300 }).idleTimeoutSeconds, 300);
  for (const idleTimeoutSeconds of [0, 59, 86401, 300.5, 'invalid']) assert.throws(() => validateConfig({ ...DEFAULTS, idleTimeoutSeconds }));
  for (const version of ['../../tmp', 'latest', '^1.2.3', 'v1.2.3']) assert.throws(() => exactVersion(version));
  assert.equal(exactVersion('1.2.3-beta.1'), '1.2.3-beta.1');
});
test('a legacy loopback public address is safely treated as unset', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, 'config.json'), { ...DEFAULTS, publicHost: '127.0.0.1' });
  assert.equal((await loadConfig(root)).publicHost, '');
});
test('channel errors remain independent and do not turn missing beta into latest', async () => {
  const versions = new Versions('/unused', {}, { fetcher: async url => url.endsWith('beta') ? { ok: false, status: 404 } : { ok: true, json: async () => ({ name: PACKAGE, version: '1.0.0', dist: { integrity: 'sha512-YQ==' } }) } });
  const result = await versions.check({ ...DEFAULTS, channels: ['latest', 'beta'] });
  assert.equal(result[0].version, '1.0.0');
  assert.match(result[1].error, /404/);
  assert.equal(result[1].version, undefined);
});
test('verified installs are unlimited, removable, and preserve existing runtimes on integrity failure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-versions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let corrupt = false;
  const versions = new Versions(root, {}, {
    fetcher: async url => ({ ok: true, json: async () => ({ name: PACKAGE, version: decodeURIComponent(url.split('/').pop()), dist: { integrity: 'sha512-YQ==' } }) }),
    execute: async (command, args, options) => {
      assert.equal(command, 'npm'); assert.ok(args.includes('--prefix')); assert.ok(!args.includes('-g'));
      const version = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(options.cwd, 'package.json'))).dependencies[PACKAGE];
      const directory = path.join(options.cwd, 'node_modules', PACKAGE);
      await mkdir(path.join(directory, 'lib'), { recursive: true });
      await writeJson(path.join(directory, 'package.json'), { name: PACKAGE, version });
      await writeFile(path.join(directory, 'lib/bin.js'), '');
      await writeJson(path.join(options.cwd, 'package-lock.json'), { packages: { [`node_modules/${PACKAGE}`]: { integrity: corrupt ? 'sha512-Yg==' : 'sha512-YQ==' } } });
    },
  });
  const progress = [];
  for (let i = 0; i < 7; i++) await versions.install(DEFAULTS, `1.0.${i}`, i === 0 ? update => progress.push(update.stage) : undefined);
  assert.deepEqual(progress, ['解析版本信息', '下载并安装运行时', '校验运行时完整性', '保存已安装版本']);
  assert.deepEqual((await versions.list()).map(x => x.version), ['1.0.6', '1.0.5', '1.0.4', '1.0.3', '1.0.2', '1.0.1', '1.0.0']);
  corrupt = true;
  await assert.rejects(versions.install(DEFAULTS, '1.0.7'), /integrity/);
  assert.equal((await versions.list()).length, 7);
  await versions.remove('1.0.3');
  assert.equal((await versions.list()).length, 6);
  await assert.rejects(versions.remove('1.0.3'), /尚未安装/);
});
