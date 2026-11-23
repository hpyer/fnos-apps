import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DnsmasqManager } from '../src/manager.mjs';

test('persists settings and records atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-dnsmasq-'));
  const manager = new DnsmasqManager(root, { binary: '/missing/dnsmasq', platform: 'linux', arch: 'x64', run: async () => '' });
  await manager.init();
  await manager.saveSettings({ listenAddresses: ['127.0.0.1'], upstreams: ['8.8.8.8'], cacheSize: 500, queryLogging: false, autoStart: true });
  await manager.saveRecords([{ type: 'suffix', domain: 'home.arpa', addresses: ['192.168.1.1'] }]);
  assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).cacheSize, 500);
  assert.match(await readFile(path.join(root, 'runtime/dnsmasq.conf'), 'utf8'), /address=\/home\.arpa\/192\.168\.1\.1/);
  assert.equal(manager.status().records.length, 1);
});

import { chmod, writeFile } from 'node:fs/promises';
import { describeStartupFailure } from '../src/manager.mjs';

test('classifies startup failures into actionable messages', () => {
  const permission = describeStartupFailure('dnsmasq: failed to create listening socket for 127.0.0.1: Permission denied', 2);
  assert.equal(permission.kind, 'permission');
  assert.match(permission.message, /CAP_NET_BIND_SERVICE/);
  const used = describeStartupFailure('dnsmasq: failed to create listening socket for 127.0.0.1: Address already in use', 2);
  assert.equal(used.kind, 'port');
  assert.match(used.message, /53 端口/);
  const moved = describeStartupFailure('dnsmasq: failed to create listening socket for 10.0.0.9: Cannot assign requested address', 2);
  assert.equal(moved.kind, 'address');
});

test('starts in keep-in-foreground mode without debug query logging', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-dnsmasq-start-'));
  const argsFile = path.join(root, 'args.txt');
  const binary = path.join(root, 'dnsmasq');
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho 'dnsmasq[1]: started, version 2.93 cachesize 1000' >&2\nexec sleep 30\n`);
  await chmod(binary, 0o755);
  const manager = new DnsmasqManager(root, { appRoot: root, binary, platform: 'linux', arch: 'x64', run: async () => '', privilegedHelperDir: path.join(root, 'helpers') });
  try {
    await manager.init();
    await manager.start();
    const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
    assert.deepEqual(args, ['--keep-in-foreground', `--conf-file=${path.join(root, 'runtime/dnsmasq.conf')}`]);
    assert.equal(manager.status().running, true);
    const config = await readFile(path.join(root, 'runtime/dnsmasq.conf'), 'utf8');
    assert.match(config, /^log-facility=-$/m);
    assert.match(config, /^pid-file=.*runtime\/dnsmasq\.pid$/m);
  } finally {
    await manager.stop();
    await manager.close();
  }
  assert.equal(manager.status().running, false);
});

test('reports missing 53 capability instead of a bare exit status', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-dnsmasq-denied-'));
  const binary = path.join(root, 'dnsmasq');
  await writeFile(binary, '#!/bin/sh\necho "dnsmasq: failed to create listening socket for 127.0.0.1: Permission denied" >&2\nexit 2\n');
  await chmod(binary, 0o755);
  const manager = new DnsmasqManager(root, { appRoot: root, binary, platform: 'linux', arch: 'x64', run: async () => '', privilegedHelperDir: path.join(root, 'helpers') });
  try {
    await manager.init();
    await assert.rejects(() => manager.start(), /CAP_NET_BIND_SERVICE|53 端口/);
    assert.match(manager.status().lastError, /CAP_NET_BIND_SERVICE/);
    assert.doesNotMatch(manager.status().lastError, /退出状态 2/);
  } finally { await manager.close(); }
});

test('hosts sync requires the root helper before enabling', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-dnsmasq-hosts-'));
  const manager = new DnsmasqManager(root, { appRoot: root, binary: '/missing/dnsmasq', platform: 'linux', arch: 'x64', run: async () => '', privilegedHelperDir: path.join(root, 'helpers') });
  try {
    await manager.init();
    await manager.saveRecords([{ type: 'suffix', domain: 'lan.home.arpa', addresses: ['192.168.1.20'] }]);
    await assert.rejects(() => manager.setHostsSync(true), /运行权限未初始化/);
    assert.equal(manager.settings.hostsSync, false);
    manager.settings.hostsSync = true;
    await manager.setHostsSync(false);
    assert.equal(manager.settings.hostsSync, false);
    assert.equal(JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).hostsSync, false);
  } finally { await manager.close(); }
});
