import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FleetManager } from '../src/runtime/fleet.mjs';
import { writeJson } from '../src/shared/config.mjs';
import { Versions } from '../src/runtime/versions.mjs';

const unsupportedVersionError = error => {
  assert.ok(error instanceof Error);
  assert.match(error.message, /0\.1\.6/);
  assert.match(error.message, /会话/);
  return true;
};

test('default selection validates minimum before installed lookup, state writes or pointer mutations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-fleet-minimum-'));
  const fakeVersions = versions(root);
  const releases = ['0.1.5', '0.1.6-rc.1', '0.1.6', '0.1.6+build', '0.1.7-rc.1'];
  fakeVersions.list = async () => releases.map(version => ({ version }));
  await writeJson(path.join(root, 'state.json'), { defaultVersion: '0.1.6' });
  await mkdir(path.join(root, 'runtimes'), { recursive: true });
  await symlink('versions/0.1.6', path.join(root, 'runtimes/current'));
  await writeFile(path.join(root, 'runtimes/current.tmp'), 'preserve pending pointer\n');
  let factories = 0;
  const fleet = new FleetManager(root, { HOME: path.join(root, 'share'), PATH: '' }, {
    versions: fakeVersions, processFactory: () => { factories += 1; assert.fail('default selection must not create processes'); },
  });
  await fleet.init();
  t.after(async () => { await fleet.stop(); await rm(root, { recursive: true, force: true }); });
  const before = await readFile(path.join(root, 'state.json'), 'utf8');
  const state = structuredClone(fleet.state);
  const files = await readdir(root, { recursive: true });
  fakeVersions.list = async () => { assert.fail('minimum check must precede installed lookup'); };
  for (const version of ['0.1.5', '0.1.6-rc.1']) {
    for (const action of [() => fleet.setDefault(version), () => fleet.dispatchAdmin('default', { version })]) {
      await assert.rejects(action(), unsupportedVersionError);
      assert.deepEqual(fleet.state, state);
      assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), before);
      assert.equal(await readlink(path.join(root, 'runtimes/current')), 'versions/0.1.6');
      assert.equal(await readFile(path.join(root, 'runtimes/current.tmp'), 'utf8'), 'preserve pending pointer\n');
      assert.deepEqual(await readdir(root, { recursive: true }), files);
      assert.equal(fleet.busy, null);
      assert.equal(fleet.tenants.size, 0);
      assert.equal(factories, 0);
    }
  }
  fakeVersions.list = async () => releases.map(version => ({ version }));
  for (const version of ['0.1.6', '0.1.6+build', '0.1.7-rc.1']) {
    await fleet.dispatchAdmin('default', { version });
    assert.equal(fleet.state.defaultVersion, version);
    assert.equal(await readlink(path.join(root, 'runtimes/current')), `versions/${version}`);
    assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).defaultVersion, version);
  }
});

test('a legacy fleet default stays visible while tenant startup fails and can be switched then removed', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-fleet-legacy-minimum-'));
  const homes = path.join(root, 'user-homes');
  const home = path.join(homes, '1000/dsh_home');
  await mkdir(home, { recursive: true });
  const installed = new Versions(root, {}, {
    fetcher: async () => { assert.fail('legacy fleet recovery must not fetch'); },
    execute: async () => { assert.fail('legacy fleet recovery must not execute npm'); },
  });
  for (const version of ['0.1.5', '0.1.6']) await writeJson(path.join(installed.location(version), 'installed.json'), { version });
  await writeJson(path.join(root, 'state.json'), { defaultVersion: '0.1.5' });
  await symlink('versions/0.1.5', path.join(root, 'runtimes/current'));
  const calls = [];
  const factory = processFactory();
  const fleet = new FleetManager(root, { HOME: path.join(root, 'share'), PATH: '' }, {
    versions: installed, userHomeRoot: homes, folderProvider: async () => [],
    processFactory: environment => {
      const process = factory(environment);
      const start = process.start.bind(process);
      const stop = process.stop.bind(process);
      process.start = async (...args) => { calls.push('start'); return start(...args); };
      process.stop = async () => { calls.push('stop'); return stop(); };
      return process;
    },
  });
  await fleet.init();
  t.after(async () => { await fleet.stop(); await rm(root, { recursive: true, force: true }); });
  await fleet.setUserHome('1000', home);
  const tenant = await fleet.tenant('1000', true);
  tenant.state.marketInstalled = true;
  await tenant.save();
  tenant.execute = async () => { assert.fail('unsupported tenant must not invoke plugin commands'); };
  const tenantState = await readFile(path.join(tenant.root, 'state.json'), 'utf8');
  await fleet.bootstrap();
  assert.equal(fleet.state.defaultVersion, '0.1.5');
  for (const action of [() => tenant.bootstrap(), () => fleet.dispatchUser('1000', true, 'restart'), () => fleet.dispatchUser('1000', true, 'market')]) {
    await assert.rejects(action(), unsupportedVersionError);
    assert.deepEqual(calls, []);
    assert.equal(await readFile(path.join(tenant.root, 'state.json'), 'utf8'), tenantState);
    assert.equal(await readlink(path.join(root, 'runtimes/current')), 'versions/0.1.5');
    const status = await fleet.userStatus('1000', true);
    assert.equal(status.minimumVersion, '0.1.6');
    assert.equal(status.defaultVersion, '0.1.5');
    assert.equal(status.current, '0.1.5');
    assert.equal(status.running, false);
    assert.equal(status.busy, null);
    assert.match(status.error, /会话/);
    assert.equal(status.versions.find(item => item.version === '0.1.5').supported, false);
  }
  await fleet.dispatchAdmin('default', { version: '0.1.6' });
  await assert.rejects(fleet.dispatchAdmin('remove', { version: '0.1.5' }), /选用/);
  await fleet.dispatchUser('1000', true, 'activate', { version: '0.1.6' });
  await fleet.dispatchAdmin('remove', { version: '0.1.5' });
  const recovered = await fleet.userStatus('1000', true);
  assert.equal(recovered.current, '0.1.6');
  assert.equal(recovered.running, true);
  assert.deepEqual(recovered.versions.map(item => item.version), ['0.1.6']);
  assert.equal(await readlink(path.join(root, 'runtimes/current')), 'versions/0.1.6');
});

function versions(root) {
  const items = ['1.0.0', '1.1.0'].map(version => ({ version, installedAt: '2026-01-01T00:00:00.000Z' }));
  return {
    list: async () => items,
    entry: version => version,
    location: version => path.join(root, 'runtimes/versions', version),
  };
}

function processFactory() {
  let port = 47000;
  return environment => ({
    environment, child: null, address: null, authCookie: '',
    async start() { this.child = {}; this.address = new URL(`http://127.0.0.1:${port++}/`); },
    async stop() { this.child = null; this.address = null; this.authCookie = ''; },
  });
}

test('fnOS users receive independent DSH homes, processes and selected versions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-fleet-'));
  const share = path.join(root, 'share');
  const homes = path.join(root, 'user-homes');
  const granted = path.join(root, 'personal-documents');
  const installed = versions(root);
  let removed = null;
  installed.remove = async version => { removed = version; };
  await mkdir(granted, { recursive: true });
  await Promise.all(['1000', '1001'].map(uid => mkdir(path.join(homes, uid), { recursive: true })));
  await writeJson(path.join(root, 'state.json'), { defaultVersion: '1.0.0' });
  const fleet = new FleetManager(root, { HOME: share, PATH: '' }, {
    versions: installed, processFactory: processFactory(), folderProvider: async uid => uid === '1000' ? [granted] : [], userHomeRoot: homes,
  });
  await fleet.init();
  t.after(async () => { await fleet.stop(); await rm(root, { recursive: true, force: true }); });
  await Promise.all(['1000', '1001'].map(async uid => {
    const home = path.join(homes, uid, 'dsh_home');
    await mkdir(home, { recursive: true });
    await fleet.setUserHome(uid, home);
  }));

  const first = await fleet.tenant('1000');
  const second = await fleet.tenant('1001');
  for (const tenant of [first, second]) { tenant.state.marketInstalled = true; await tenant.save(); }
  assert.notEqual(first.environment.DSH_HOME, second.environment.DSH_HOME);
  assert.equal(first.environment.HOME, path.join(homes, '1000/dsh_home'));
  assert.equal(second.environment.HOME, path.join(homes, '1001/dsh_home'));
  assert.equal(first.environment.pnpm_config_store_dir, path.join(root, 'users/1000/pnpm-store'));
  assert.equal(second.environment.pnpm_config_store_dir, path.join(root, 'users/1001/pnpm-store'));
  assert.equal(first.state.current, '1.0.0');
  assert.equal(second.state.current, '1.0.0');

  await fleet.dispatchUser('1000', false, 'start');
  await fleet.dispatchUser('1001', false, 'start');
  assert.notEqual(first.process.address.port, second.process.address.port);
  await fleet.dispatchUser('1000', false, 'activate', { version: '1.1.0' });
  assert.equal(first.state.current, '1.1.0');
  assert.equal(second.state.current, '1.0.0');

  const folders = await fleet.syncFolders('1000', first);
  assert.deepEqual(folders.paths, [granted]);
  const [link] = await (await import('node:fs/promises')).readdir(folders.directory);
  assert.equal(await readlink(path.join(folders.directory, link)), granted);

  await assert.rejects(fleet.dispatchAdmin('remove', { version: '1.1.0' }), /正被 1 个用户运行/);
  await first.process.stop();
  await assert.rejects(fleet.dispatchAdmin('remove', { version: '1.1.0' }), /仍被 1 个用户选用/);
  first.state.current = '1.0.0'; await first.save();
  await fleet.dispatchAdmin('remove', { version: '1.1.0' });
  assert.equal(removed, '1.1.0');
  await assert.rejects(fleet.dispatchAdmin('remove', { version: '1.0.0' }), /默认版本无法删除/);
});

test('legacy shared DSH home is assigned to the first administrator tenant', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-fleet-migrate-'));
  const share = path.join(root, 'share');
  const homes = path.join(root, 'user-homes');
  await mkdir(path.join(share, '.dsh'), { recursive: true });
  await mkdir(path.join(share, 'workspace'), { recursive: true });
  await writeFile(path.join(share, '.dsh/settings.yaml'), 'models: {}\n');
  await writeFile(path.join(share, 'workspace/README.md'), '# existing\n');
  await Promise.all(['1000', '1001'].map(uid => mkdir(path.join(homes, uid), { recursive: true })));
  await writeJson(path.join(root, 'state.json'), { current: '1.0.0', marketInstalled: true });
  const fleet = new FleetManager(root, { HOME: share, PATH: '' }, { versions: versions(root), processFactory: processFactory(), folderProvider: async () => [], userHomeRoot: homes });
  await fleet.init();
  t.after(async () => { await fleet.stop(); await rm(root, { recursive: true, force: true }); });
  await Promise.all(['1000', '1001'].map(async uid => {
    const home = path.join(homes, uid, 'dsh_home');
    await mkdir(home, { recursive: true });
    await fleet.setUserHome(uid, home);
  }));

  await fleet.tenant('1001', false);
  assert.equal(await readFile(path.join(share, '.dsh/settings.yaml'), 'utf8'), 'models: {}\n');
  const admin = await fleet.tenant('1000', true);
  assert.equal(await readFile(path.join(admin.environment.DSH_HOME, 'settings.yaml'), 'utf8'), 'models: {}\n');
  assert.equal(await readFile(path.join(admin.environment.HOME, 'workspace/README.md'), 'utf8'), '# existing\n');
  assert.equal(admin.state.marketInstalled, true);
});

test('global download progress is separate from the current user runtime status', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-fleet-progress-'));
  const homes = path.join(root, 'user-homes');
  const fakeVersions = versions(root);
  let continueInstall;
  const installStarted = new Promise(resolve => {
    fakeVersions.install = async (_config, version, report) => {
      report({ step: 2, total: 4, stage: '下载并安装运行时' });
      resolve();
      await new Promise(done => { continueInstall = done; });
      report({ step: 4, total: 4, stage: '保存已安装版本' });
      assert.equal(version, '1.1.0');
    };
  });
  const fleet = new FleetManager(root, { HOME: path.join(root, 'share'), PATH: '' }, {
    versions: fakeVersions, processFactory: processFactory(), folderProvider: async () => [], userHomeRoot: homes,
  });
  await mkdir(path.join(homes, '1000'), { recursive: true });
  await writeJson(path.join(root, 'state.json'), { defaultVersion: '1.0.0' });
  await fleet.init();
  t.after(async () => { continueInstall?.(); await fleet.stop(); await rm(root, { recursive: true, force: true }); });
  const home = path.join(homes, '1000/dsh_home');
  await mkdir(home, { recursive: true });
  await fleet.setUserHome('1000', home);

  const download = fleet.dispatchAdmin('download', { version: '1.1.0' });
  await installStarted;

  const user = await fleet.tenant('1000');
  user.state.marketInstalled = true;
  await user.save();
  await fleet.dispatchUser('1000', false, 'start');
  assert.equal(user.state.current, '1.0.0');
  assert.equal(user.process.address.port > 0, true);

  const status = await fleet.userStatus('1000', true);
  assert.equal(status.current, '1.0.0');
  assert.equal(status.running, true);
  assert.equal(status.globalBusy, '下载版本');
  assert.deepEqual(status.globalTask, {
    type: 'download', version: '1.1.0', step: 2, total: 4, stage: '下载并安装运行时', startedAt: status.globalTask.startedAt,
  });
  continueInstall();
  await download;
  assert.equal(fleet.globalTask, null);
});

test('first application start downloads latest, then starts the administrator tenant', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-fleet-bootstrap-'));
  const homes = path.join(root, 'user-homes');
  const fakeVersions = versions(root);
  const installed = [];
  fakeVersions.list = async () => installed.map(version => ({ version, installedAt: '2026-01-01T00:00:00.000Z' }));
  fakeVersions.metadata = async (_config, channel) => { assert.equal(channel, 'latest'); return { version: '1.2.3' }; };
  fakeVersions.install = async (_config, version, report) => { report({ step: 2, total: 4, stage: '下载并安装运行时' }); installed.push(version); };
  await mkdir(path.join(homes, '1000/dsh_home'), { recursive: true });
  const fleet = new FleetManager(root, { HOME: path.join(root, 'share'), PATH: '' }, { versions: fakeVersions, processFactory: processFactory(), folderProvider: async () => [], userHomeRoot: homes });
  await fleet.init();
  t.after(async () => { await fleet.stop(); await rm(root, { recursive: true, force: true }); });
  await fleet.setUserHome('1000', path.join(homes, '1000/dsh_home'));
  const tenant = await fleet.tenant('1000', true);
  tenant.state.marketInstalled = true; await tenant.save();
  const pending = fleet.bootstrap();
  assert.equal(fleet.globalTask?.type, 'download');
  await pending;
  assert.deepEqual(installed, ['1.2.3']);
  assert.equal(fleet.state.defaultVersion, '1.2.3');
  assert.equal(fleet.globalTask, null);
  const status = await fleet.userStatus('1000', true);
  assert.equal(status.running, true);
  assert.equal(fleet.state.initialLaunchPending, false);
});

test('idle DSH tenants close automatically and active connections keep them running', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-fleet-idle-'));
  const homes = path.join(root, 'user-homes');
  await mkdir(path.join(homes, '1001/dsh_home'), { recursive: true });
  await writeJson(path.join(root, 'state.json'), { defaultVersion: '1.0.0' });
  const fleet = new FleetManager(root, { HOME: path.join(root, 'share'), PATH: '' }, { versions: versions(root), processFactory: processFactory(), folderProvider: async () => [], userHomeRoot: homes });
  await fleet.init();
  t.after(async () => { await fleet.stop(); await rm(root, { recursive: true, force: true }); });
  await fleet.setUserHome('1001', path.join(homes, '1001/dsh_home'));
  const tenant = await fleet.tenant('1001');
  tenant.state.marketInstalled = true; await tenant.save();
  await fleet.dispatchUser('1001', false, 'start');
  fleet.config.idleTimeoutSeconds = 60;
  tenant.lastActivityAt = Date.now() - 61_000;
  const release = tenant.openActivityConnection();
  await fleet.closeIdleTenants();
  assert.ok(tenant.process.address);
  release();
  tenant.lastActivityAt = Date.now() - 61_000;
  await fleet.closeIdleTenants();
  assert.equal(tenant.process.address, null);
});

test('a user must authorize their real fnOS home before a DSH tenant is created', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-fleet-home-access-'));
  const homes = path.join(root, 'user-homes');
  const fleet = new FleetManager(root, { HOME: path.join(root, 'share'), PATH: '' }, {
    versions: versions(root), processFactory: processFactory(), folderProvider: async () => [], userHomeRoot: homes,
  });
  await writeJson(path.join(root, 'state.json'), { defaultVersion: '1.0.0' });
  await fleet.init();
  t.after(async () => { await fleet.stop(); await rm(root, { recursive: true, force: true }); });

  const pending = await fleet.userStatus('1001', false);
  assert.equal(pending.minimumVersion, '0.1.6');
  assert.equal(pending.needsHomeAuthorization, true);
  assert.equal(pending.userHome, path.join(homes, '1001'));
  assert.equal(pending.userRoot, path.join(homes, '1001'));
  assert.equal(pending.homeSelectionRequired, true);
  assert.equal(fleet.tenants.size, 0);

  await mkdir(path.join(homes, '1001/dsh_home'), { recursive: true });
  await assert.rejects(fleet.setUserHome('1001', path.join(homes, '1001')), /子目录/);
  await assert.rejects(fleet.setUserHome('1001', path.join(homes, '1000/dsh_home')), /子目录/);
  assert.equal(await fleet.setUserHome('1001', path.join(homes, '1001/dsh_home')), path.join(homes, '1001/dsh_home'));
});
