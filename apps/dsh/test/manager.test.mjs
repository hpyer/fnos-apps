import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../src/runtime/manager.mjs';
import { writeJson } from '../src/shared/config.mjs';
import { Versions, versionAvailability } from '../src/runtime/versions.mjs';

const unsupportedVersionError = error => {
  assert.ok(error instanceof Error);
  assert.match(error.message, /0\.1\.6/);
  assert.match(error.message, /会话/);
  return true;
};

async function guardedFixture(t, current = '0.1.6') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-manager-minimum-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'runtimes'), { recursive: true });
  await writeJson(path.join(root, 'state.json'), { current, marketInstalled: true });
  await symlink(`versions/${current}`, path.join(root, 'runtimes/current'));
  await writeFile(path.join(root, 'host.cordis.patch.yml'), 'unchanged patch\n');
  const calls = [];
  const child = {};
  const address = new URL('http://127.0.0.1:47000/');
  const process = {
    child, address,
    stop: async () => { calls.push('stop'); process.child = null; process.address = null; },
    start: async version => { calls.push(`start:${version}`); process.child = {}; process.address = address; },
  };
  const items = ['0.1.5', '0.1.6-rc.1', '0.1.6', '0.1.6+build', '0.1.7-rc.1'].map(version => ({ version, custom: 'preserved' }));
  const versions = {
    list: async () => items,
    entry: version => { calls.push(`entry:${version}`); return version; },
    location: version => { calls.push(`location:${version}`); return root; },
  };
  const manager = new Manager(root, { DSH_HOME: path.join(root, 'home'), PATH: '' }, {
    process, versions,
    execute: async () => { calls.push('plugin'); },
    watch: () => { calls.push('watch'); return { close() {} }; },
  });
  await manager.init();
  return { root, manager, calls, items, child, address };
}

test('manager status exposes the fixed minimum and annotates every injected installed entry', async t => {
  const { manager, items } = await guardedFixture(t, '0.1.5');
  const status = await manager.status();
  assert.equal(status.minimumVersion, '0.1.6');
  assert.equal(status.current, '0.1.5');
  assert.deepEqual(status.versions, items.map(versionAvailability));
  assert.ok(items.every(item => !Object.hasOwn(item, 'supported')));
});

test('unsupported activation and startup reject before process, plugin, state or disk mutations', async t => {
  const { root, manager, calls, child, address } = await guardedFixture(t);
  for (const version of ['0.1.5', '0.1.6-rc.1']) {
    for (const action of [() => manager.activate(version), () => manager.startVersion(version), () => manager.dispatch('activate', { version })]) {
      const state = structuredClone(manager.state);
      const diskState = await readFile(path.join(root, 'state.json'), 'utf8');
      const files = await readdir(root, { recursive: true });
      await assert.rejects(action(), unsupportedVersionError);
      assert.deepEqual(calls, []);
      assert.deepEqual(manager.state, state);
      assert.equal(manager.process.child, child);
      assert.equal(manager.process.address, address);
      assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), diskState);
      assert.equal(await readFile(path.join(root, 'host.cordis.patch.yml'), 'utf8'), 'unchanged patch\n');
      assert.equal(await readlink(path.join(root, 'runtimes/current')), 'versions/0.1.6');
      assert.deepEqual(await readdir(root, { recursive: true }), files);
      assert.equal(manager.busy, null);
    }
  }
});

test('ensureMarket guards unsupported versions even when already installed and leaves profile data intact', async t => {
  const { root, manager, calls } = await guardedFixture(t);
  const profile = path.join(manager.environment.DSH_HOME, 'profiles/web');
  await mkdir(path.join(profile, 'node_modules/example'), { recursive: true });
  await writeFile(path.join(profile, 'package.json'), '{"private":true}\n');
  await writeFile(path.join(profile, 'pnpm-lock.yaml'), 'keep lockfile\n');
  await writeFile(path.join(profile, 'node_modules/example/data.txt'), 'keep dependencies\n');
  for (const marketInstalled of [true, false]) {
    manager.state.marketInstalled = marketInstalled;
    await manager.save();
    const diskState = await readFile(path.join(root, 'state.json'), 'utf8');
    for (const version of ['0.1.5', '0.1.6-rc.1']) await assert.rejects(manager.ensureMarket(version), unsupportedVersionError);
    assert.equal(manager.state.marketInstalled, marketInstalled);
    assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), diskState);
    assert.deepEqual(calls, []);
    assert.equal(await readFile(path.join(profile, 'package.json'), 'utf8'), '{"private":true}\n');
    assert.equal(await readFile(path.join(profile, 'pnpm-lock.yaml'), 'utf8'), 'keep lockfile\n');
    assert.equal(await readFile(path.join(profile, 'node_modules/example/data.txt'), 'utf8'), 'keep dependencies\n');
  }
});

test('market dispatch guards a selected legacy version before stop, market flag reset or state save', async t => {
  for (const version of ['0.1.5', '0.1.6-rc.1']) {
    const { root, manager, calls, child, address } = await guardedFixture(t, version);
    const before = await readFile(path.join(root, 'state.json'), 'utf8');
    const files = await readdir(root, { recursive: true });
    await assert.rejects(manager.dispatch('market'), unsupportedVersionError);
    assert.deepEqual(calls, []);
    assert.equal(manager.state.current, version);
    assert.equal(manager.state.marketInstalled, true);
    assert.equal(manager.process.child, child);
    assert.equal(manager.process.address, address);
    assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), before);
    assert.equal(await readlink(path.join(root, 'runtimes/current')), `versions/${version}`);
    assert.deepEqual(await readdir(root, { recursive: true }), files);
    assert.equal(manager.busy, null);
    assert.match(manager.error, /0\.1\.6/);
  }
});

test('supported semver boundaries can be activated and committed as exact version pointers', async t => {
  const { root, manager, calls } = await guardedFixture(t);
  for (const version of ['0.1.6', '0.1.6+build', '0.1.7-rc.1']) {
    calls.length = 0;
    await manager.dispatch('activate', { version });
    assert.equal(manager.state.current, version);
    assert.equal(await readlink(path.join(root, 'runtimes/current')), `versions/${version}`);
    assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).current, version);
    assert.ok(calls.includes(`start:${version}`));
  }
});

test('a selected legacy runtime fails bootstrap and restart gracefully then permits supported switch and removal', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-manager-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const versions = new Versions(root, {}, {
    fetcher: async () => { assert.fail('legacy recovery must not fetch'); },
    execute: async () => { assert.fail('legacy recovery must not install runtimes'); },
  });
  for (const version of ['0.1.5', '0.1.6']) await writeJson(path.join(versions.location(version), 'installed.json'), { version });
  await writeJson(path.join(root, 'state.json'), { current: '0.1.5', marketInstalled: true });
  await symlink('versions/0.1.5', path.join(root, 'runtimes/current'));
  const calls = [];
  const process = {
    child: null, address: null,
    stop: async () => { calls.push('stop'); process.child = null; process.address = null; },
    start: async entry => { calls.push(entry); process.child = {}; process.address = new URL('http://127.0.0.1:47000/'); },
  };
  const manager = new Manager(root, { DSH_HOME: path.join(root, 'home'), PATH: '' }, {
    versions, process, execute: async () => { assert.fail('legacy recovery must not invoke plugins'); },
    watch: () => ({ close() {} }),
  });
  await manager.init();
  const diskState = await readFile(path.join(root, 'state.json'), 'utf8');
  for (const action of [() => manager.bootstrap(), () => manager.dispatch('restart')]) {
    await assert.rejects(action(), unsupportedVersionError);
    assert.deepEqual(calls, []);
    assert.equal(await readFile(path.join(root, 'state.json'), 'utf8'), diskState);
    assert.equal(await readlink(path.join(root, 'runtimes/current')), 'versions/0.1.5');
    const status = await manager.status();
    assert.equal(status.current, '0.1.5');
    assert.equal(status.running, false);
    assert.equal(status.busy, null);
    assert.match(status.error, /会话/);
    assert.equal(status.versions.find(item => item.version === '0.1.5').supported, false);
  }
  await assert.rejects(manager.dispatch('remove', { version: '0.1.5' }), /当前版本/);
  await manager.dispatch('activate', { version: '0.1.6' });
  assert.equal(manager.state.current, '0.1.6');
  assert.equal((await manager.status()).running, true);
  await manager.dispatch('remove', { version: '0.1.5' });
  assert.deepEqual((await manager.status()).versions.map(item => item.version), ['0.1.6']);
  assert.equal(await readlink(path.join(root, 'runtimes/current')), 'versions/0.1.6');
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-manager-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'runtimes'), { recursive: true });
  await writeJson(path.join(root, 'state.json'), { current: '1.0.0', marketInstalled: true });
  const starts = [];
  const process = { child: null, address: null, stop: async () => { process.child = null; }, start: async entry => { starts.push(entry); if (entry === '1.0.1') throw new Error('bad plugin'); process.child = {}; } };
  const versions = { list: async () => [{ version: '1.0.0' }, { version: '1.0.1' }], entry: x => x, location: () => root };
  const manager = new Manager(root, { DSH_HOME: path.join(root, 'home'), PATH: '' }, { process, versions });
  await manager.init();
  return { manager, root, starts };
}
test('failed activation restores old process and leaves the healthy pointer intact', async t => {
  const { manager, root, starts } = await fixture(t);
  await manager.activate('1.0.0');
  await assert.rejects(manager.dispatch('activate', { version: '1.0.1' }), /bad plugin/);
  assert.equal(manager.state.current, '1.0.0');
  assert.equal(await readlink(path.join(root, 'runtimes/current')), 'versions/1.0.0');
  assert.deepEqual(starts, ['1.0.0', '1.0.1', '1.0.0']);
  assert.equal(manager.busy, null);
  assert.ok(manager.process.child);
});
test('lifecycle mutations cannot overlap', async t => {
  const { manager } = await fixture(t);
  let release;
  const pending = manager.exclusive('下载', () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(manager.dispatch('restart'), /请稍后/);
  release(); await pending;
  assert.equal(manager.busy, null);
});
test('a committed healthy pointer survives auxiliary state-file failure and reload', async t => {
  const { manager, root } = await fixture(t);
  manager.save = async () => { throw new Error('disk full'); };
  await manager.activate('1.0.0');
  assert.ok(manager.process.child);
  assert.equal(await readlink(path.join(root, 'runtimes/current')), 'versions/1.0.0');
  await writeJson(path.join(root, 'state.json'), { current: '9.9.9', marketInstalled: true });
  await manager.init();
  assert.equal(manager.state.current, '1.0.0');
});
test('market install runs only until it succeeds, then survives restarts', async t => {
  const { manager } = await fixture(t);
  manager.state.marketInstalled = false;
  let attempts = 0;
  manager.execute = async (_cmd, args) => { assert.deepEqual(args.slice(1), ['plugin', '--profile', 'web', 'add', 'dshmarket']); if (++attempts === 1) throw new Error('network unavailable'); };
  await assert.rejects(manager.ensureMarket('1.0.0'));
  assert.equal(manager.state.marketInstalled, false);
  await manager.ensureMarket('1.0.0');
  await manager.ensureMarket('1.0.0');
  assert.equal(attempts, 2);
});
test('market installation rebuilds only derived profile dependencies after an EACCES failure', async t => {
  const { manager } = await fixture(t);
  manager.state.marketInstalled = false;
  const profile = path.join(manager.environment.DSH_HOME, 'profiles/web');
  await mkdir(path.join(profile, 'node_modules/argparse'), { recursive: true });
  await writeFile(path.join(profile, 'node_modules/argparse/package.json'), '{}');
  await writeFile(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  let attempts = 0;
  manager.execute = async () => { if (++attempts === 1) throw new Error('pnpm failed: EACCES: permission denied'); };
  await manager.ensureMarket('1.0.0');
  assert.equal(attempts, 2);
  await assert.rejects(readFile(path.join(profile, 'node_modules/argparse/package.json'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(path.join(profile, 'pnpm-lock.yaml'), 'utf8'), /ENOENT/);
  assert.equal(manager.state.marketInstalled, true);
});
test('market installation backs up an unreadable web profile before recreating it', async t => {
  const { manager } = await fixture(t);
  manager.state.marketInstalled = false;
  const profiles = path.join(manager.environment.DSH_HOME, 'profiles');
  const profile = path.join(profiles, 'web');
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'package.json'), '{}');
  let attempts = 0;
  manager.execute = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('pnpm failed: EACCES: permission denied');
    if (attempts === 2) throw new Error(`dsh: failed to read profile manifest ${path.join(profile, 'package.json')}: Error: EACCES: permission denied`);
    if (attempts === 3) {
      await mkdir(path.join(profile, 'node_modules/example'), { recursive: true });
      await writeFile(path.join(profile, 'package.json'), '{}', { mode: 0o600 });
      await writeFile(path.join(profile, 'node_modules/example/package.json'), '{}', { mode: 0o600 });
      throw new Error(`dsh: failed to read profile manifest ${path.join(profile, 'package.json')}: Error: EACCES: permission denied`);
    }
  };
  await manager.ensureMarket('1.0.0');
  assert.equal(attempts, 4);
  const entries = await (await import('node:fs/promises')).readdir(profiles);
  assert.ok(entries.some(name => name.startsWith('web.permission-backup-')));
  assert.equal((await stat(path.join(profile, 'package.json'))).mode & 0o777, 0o644);
  assert.equal((await stat(path.join(profile, 'node_modules/example/package.json'))).mode & 0o777, 0o644);
  assert.equal(manager.state.marketInstalled, true);
});
test('a completed web-profile plugin operation is restarted by the supervisor', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-manager-profile-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await mkdir(path.join(root, 'runtimes'), { recursive: true });
  await mkdir(path.join(home, 'profiles/web'), { recursive: true });
  await writeJson(path.join(root, 'state.json'), { current: '1.0.0', marketInstalled: true });
  let listener;
  let closed = false;
  const manager = new Manager(root, { DSH_HOME: home, PATH: '' }, {
    versions: { list: async () => [] }, process: { stop: async () => {} }, pluginRestartDelay: 1,
    watch: (_directory, _options, callback) => { listener = callback; return { close: () => { closed = true; } }; },
  });
  await manager.init();
  const actions = [];
  manager.dispatch = async action => { actions.push(action); };
  manager.watchPluginProfile();
  listener('change', 'package.json');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(actions, []);
  listener('rename', 'pnpm-lock.yaml');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(actions, ['restart']);
  await manager.stop();
  assert.equal(closed, true);
});

test('plugin restart waits until dsh-market has finished its update response', async t => {
  const { manager } = await fixture(t);
  manager.pluginRestartDelay = 1;
  let active = true;
  manager.process.pluginOperationActive = async () => active;
  const actions = [];
  manager.dispatch = async action => { actions.push(action); };
  manager.schedulePluginRestart();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(actions, []);
  active = false;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(actions, ['restart']);
});

test('plugin restart requires consecutive valid idle status checks', async t => {
  const { manager } = await fixture(t);
  manager.pluginRestartDelay = 1;
  const states = ['unavailable', 'idle', 'active', 'idle', 'idle'];
  manager.process.pluginOperationState = async () => states.shift() ?? 'idle';
  const actions = [];
  manager.dispatch = async action => { actions.push(action); };
  manager.schedulePluginRestart();
  await new Promise(resolve => setTimeout(resolve, 4));
  assert.deepEqual(actions, []);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(actions, ['restart']);
});

test('a stale idle check cannot restart after a newer plugin change', async t => {
  const { manager } = await fixture(t);
  manager.pluginRestartDelay = 1;
  manager.pluginRestartIdleRequired = 1;
  let release;
  manager.process.pluginOperationState = () => new Promise(resolve => { release = resolve; });
  const actions = [];
  manager.dispatch = async action => { actions.push(action); };
  manager.schedulePluginRestart();
  await new Promise(resolve => setTimeout(resolve, 4));
  manager.pluginChangeGeneration += 1;
  manager.process.pluginOperationState = async () => 'active';
  release('idle');
  await new Promise(resolve => setTimeout(resolve, 8));
  assert.deepEqual(actions, []);
  await manager.stop();
});

test('moves the settings document into the declared fnOS data share', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-manager-share-'));
  const home = path.join(root, 'home/.dsh');
  const share = path.join(root, 'share');
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'settings.yaml'), 'models:\n  example: {}\n');
  const manager = new Manager(root, { DSH_HOME: home, TRIM_DATA_SHARE_PATHS: share, PATH: '/usr/bin' }, {
    versions: { list: async () => [] }, process: { stop: async () => {} },
  });
  await manager.init();
  assert.equal(manager.settingsDocument, path.join(share, 'settings.yaml'));
  assert.equal(await readFile(manager.settingsDocument, 'utf8'), 'models:\n  example: {}\n');
  assert.equal(await readlink(path.join(home, 'settings.yaml')), manager.settingsDocument);
  await rm(root, { recursive: true, force: true });
});

test('migrates DSH workspaces and configuration from appdata into the shared home', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-manager-home-migration-'));
  const legacy = path.join(root, 'home');
  const share = path.join(root, 'appshare/dsh-for-fnos');
  await mkdir(path.join(legacy, '.dsh'), { recursive: true });
  await mkdir(path.join(legacy, 'workspace-a'), { recursive: true });
  await writeFile(path.join(legacy, '.dsh/settings.yaml'), 'models:\n  example: {}\n');
  await writeFile(path.join(legacy, 'workspace-a/README.md'), '# migrated\n');
  const manager = new Manager(root, {
    HOME: share, DSH_HOME: path.join(share, '.dsh'), DSH_LEGACY_HOME: legacy,
    TRIM_DATA_SHARE_PATHS: share, PATH: '/usr/bin',
  }, { versions: { list: async () => [] }, process: { stop: async () => {} } });
  await manager.init();
  assert.equal(await readFile(path.join(share, 'workspace-a/README.md'), 'utf8'), '# migrated\n');
  assert.equal(await readFile(path.join(share, '.dsh/settings.yaml'), 'utf8'), 'models:\n  example: {}\n');
  await assert.rejects(readFile(path.join(legacy, 'workspace-a/README.md')));
  await assert.rejects(readFile(legacy));
  assert.equal(manager.settingsDocument, path.join(share, '.dsh/settings.yaml'));
  await rm(root, { recursive: true, force: true });
});
