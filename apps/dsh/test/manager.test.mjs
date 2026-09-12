import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../src/runtime/manager.mjs';
import { writeJson } from '../src/shared/config.mjs';

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
