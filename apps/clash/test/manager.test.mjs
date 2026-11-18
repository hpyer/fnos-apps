import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClashManager } from '../src/manager.mjs';
import { hashFile } from '../src/storage.mjs';

const FAKE_CORE = fileURLToPath(new URL('./fixtures/fake-core.mjs', import.meta.url));

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeout = 10000, interval = 80) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(interval);
  }
  throw Error('测试等待超时');
}

function configSource(port, extra = '') {
  return `mixed-port: ${port}\nmode: rule\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n${extra}`;
}

async function setup(t, options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clash-manager-'));
  const root = path.join(base, 'var');
  const appRoot = path.join(base, 'app');
  await mkdir(appRoot, { recursive: true });
  const controlFile = path.join(base, 'control.json');
  await writeFile(controlFile, JSON.stringify(options.control || {}));
  process.env.FAKE_CORE_CONTROL = controlFile;
  const manager = new ClashManager(root, {
    appRoot, platform: 'linux', arch: 'x64', fetcher: options.fetcher, resolver: options.resolver, systemEnvironmentFile: options.systemEnvironmentFile, privilegedHelperDir: options.privilegedHelperDir, bootstrapData: options.bootstrapData === true,
  });
  manager.validateCore = async () => ({ version: '1.19.33', flavor: 'MetaCubeX' });
  await manager.init();
  t.after(async () => {
    await manager.close();
    await rm(base, { recursive: true, force: true });
    delete process.env.FAKE_CORE_CONTROL;
  });
  return { base, root, appRoot, manager, controlFile };
}

async function addFakeCore(manager, id, { version = '1.19.33', channel = 'metacubex-stable' } = {}) {
  const directory = path.join(manager.installedDir, id);
  await mkdir(directory, { recursive: true });
  const binary = path.join(directory, 'mihomo');
  await copyFile(FAKE_CORE, binary);
  await chmod(binary, 0o755);
  const metadata = {
    id, channel, channelLabel: 'MetaCubeX 稳定版', version, tag: `v${version}`, build: '', arch: 'x86_64',
    sha256: 'a'.repeat(64), binarySha256: await hashFile(binary), size: 1024, verified: true,
    source: 'https://github.com/MetaCubeX/mihomo', license: 'GPL-3.0', installedAt: new Date().toISOString(),
  };
  await writeFile(path.join(directory, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

async function activateManually(manager, id) {
  manager.activeId = id;
  manager.previousId = '';
  await manager.writeActive();
}

async function startedManager(t, port = 23456, options = {}) {
  const fixture = await setup(t, options);
  await addFakeCore(fixture.manager, 'installed-one');
  await activateManually(fixture.manager, 'installed-one');
  await fixture.manager.config.save(configSource(port));
  await fixture.manager.startCore();
  return fixture;
}

test('初始化状态可用，没有内置 Core 时给出提示', async t => {
  const { manager } = await setup(t);
  const status = await manager.status();
  assert.equal(status.platform.supported, true);
  assert.equal(status.core.state, 'stopped');
  assert.equal(status.versions.installed.length, 0);
  assert.deepEqual(status.versions.embedded, []);
  assert.equal(status.versions.channel, 'metacubex-stable');
});

test('启动后提供代理、连接、流量与日志，停止后状态归零', async t => {
  const { manager } = await startedManager(t, 23457);
  const status = await manager.status();
  assert.equal(status.core.state, 'running');
  assert.equal(status.core.activeId, 'installed-one');
  await waitFor(() => manager.traffic.down > 0);
  await waitFor(() => manager.logsHistory().some(entry => entry.message.includes('fake log line')));
  await waitFor(() => manager.connectionCount > 0);

  const proxies = await manager.proxies();
  assert.equal(proxies.mode, 'rule');
  const group = proxies.groups.find(item => item.name === 'Proxy');
  assert.equal(group.type, 'Selector');
  assert.equal(group.now, 'Node A');
  await manager.selectProxy('Proxy', 'Node B');
  assert.equal((await manager.proxies()).groups.find(item => item.name === 'Proxy').now, 'Node B');
  assert.equal((await manager.delay('Node A')).delay, 120);
  assert.deepEqual((await manager.groupDelay('Proxy')).delays, { 'Node A': 120, 'Node B': 460 });
  const delays = await manager.delayAll();
  assert.equal(delays.tested, 4);
  assert.ok(delays.groups.Proxy);
  assert.equal((await manager.status()).environment.tunEnabled, false);
  const connections = await manager.connections();
  assert.equal(connections.connections.length, 1);
  assert.equal(connections.connections[0].host, 'example.com');
  await manager.closeConnection('conn-1');

  await manager.stopCore();
  const stopped = await manager.status();
  assert.equal(stopped.core.state, 'stopped');
  assert.equal(stopped.core.running, false);
  assert.equal(stopped.core.connections, 0);
});

test('配置保存成功后重启，失败自动回滚且当前配置不变', async t => {
  const { manager } = await startedManager(t, 23458);
  const before = await manager.readConfig();
  const beforePid = manager.core.pid;
  await manager.saveConfig(configSource(23458, 'test-marker: 1\n'));
  const afterSave = await manager.readConfig();
  assert.equal(afterSave.source, configSource(23458, 'test-marker: 1\n'));
  assert.equal((await manager.status()).core.state, 'running');
  assert.notEqual(manager.core.pid, beforePid);

  const backupsBefore = (await manager.listBackups()).length;
  await assert.rejects(() => manager.saveConfig(configSource(23458, 'INVALID_CONFIG: true\n')), /配置校验失败/);
  assert.equal((await manager.readConfig()).source, afterSave.source);
  assert.equal((await manager.listBackups()).length, backupsBefore, '校验失败不应新增备份');
  const unchanged = await manager.saveConfig((await manager.readConfig()).source);
  assert.equal(unchanged.configSaved, false);
  assert.equal((await manager.listBackups()).length, backupsBefore, '无变动不应新增备份');
  assert.equal((await manager.status()).core.state, 'running');
});

test('切换代理模式写入配置并通知运行中的 Core', async t => {
  const { manager } = await startedManager(t, 23459);
  await manager.setMode('global');
  assert.equal((await manager.readConfig()).info.mode, 'global');
  assert.equal((await manager.status()).core.mode, 'global');
  await manager.setMode('rule');
  assert.equal((await manager.status()).core.mode, 'rule');
  await assert.rejects(() => manager.setMode('turbo'), /代理模式无效/);

  await manager.config.save('mixed-port: 23459\nmode: rule\nexternal-controller: 0.0.0.0:9090\nsecret: old\nlog-level: debug\nproxies: []\nrules:\n  - MATCH,DIRECT\n');
  const config = await manager.readConfig();
  assert.ok(config.managedKeys.includes('external-controller'));
  assert.ok(config.managedKeys.includes('secret'));
  assert.ok(config.managedKeys.includes('log-level'));
});

test('订阅下载与应用会替换配置并重启 Core', async t => {
  const subscription = '# downloaded subscription\nmixed-port: 23460\nmode: rule\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n';
  const { manager } = await startedManager(t, 23460, {
    fetcher: async () => new Response(subscription, { status: 200 }),
    resolver: async () => [{ address: '93.184.216.34' }],
  });
  const added = await manager.addSubscription({ name: '测试订阅', url: 'https://sub.example.com/api?token=hidden', intervalHours: 0 });
  assert.match(added.urlMasked, /\?\*\*\*/);
  await manager.updateSubscription(added.id);
  await manager.applySubscription(added.id);
  const config = await manager.readConfig();
  assert.equal(config.kind, 'subscription');
  assert.equal(config.subscriptionId, added.id);
  assert.equal((await manager.status()).core.state, 'running');
  await manager.deleteSubscription(added.id);
  assert.equal((await manager.status()).subscriptions.length, 0);
});

test('版本启用、回滚和删除保护', async t => {
  const { manager } = await setup(t);
  await addFakeCore(manager, 'installed-one');
  await addFakeCore(manager, 'installed-two', { version: '1.19.32' });
  await activateManually(manager, 'installed-one');
  await manager.config.save(configSource(23461));
  await manager.startCore();

  await manager.startJob('activate', 'installed-two');
  await manager.jobTask;
  assert.equal(manager.job.state, 'success');
  assert.equal(manager.activeId, 'installed-two');
  assert.equal(manager.previousId, 'installed-one');
  assert.equal((await manager.status()).core.state, 'running');

  await manager.startJob('rollback');
  await manager.jobTask;
  assert.equal(manager.activeId, 'installed-one');
  assert.equal(manager.previousId, 'installed-two');

  await manager.startJob('remove', 'installed-one');
  await manager.jobTask;
  assert.equal(manager.job.state, 'error');
  assert.match(manager.job.message, /不能删除当前/);

  await manager.startJob('remove', 'installed-two');
  await manager.jobTask;
  assert.equal(manager.job.state, 'success');
  assert.equal(manager.previousId, '');
  const versions = (await manager.status()).versions;
  assert.deepEqual(versions.installed.map(item => item.id), ['installed-one']);
});

test('安装任务校验 SHA256 元数据、单一任务互斥并记录元数据', async t => {
  const { manager } = await setup(t);
  const entry = {
    id: 'metacubex-stable-v1.19.33-x86_64', channel: 'metacubex-stable', channelLabel: 'MetaCubeX 稳定版',
    version: 'v1.19.33', tag: 'v1.19.33', build: '', arch: 'x86_64', name: 'mihomo-linux-amd64-v1.19.33.gz',
    url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33/mihomo-linux-amd64-v1.19.33.gz',
    sha256: 'b'.repeat(64), size: 1024, verified: true, risk: false, publishedAt: '2026-11-01T00:00:00Z',
    source: 'https://github.com/MetaCubeX/mihomo', repository: 'MetaCubeX/mihomo', license: 'GPL-3.0',
  };
  manager.available = { channel: 'metacubex-stable', entries: [entry], checkedAt: new Date().toISOString(), error: '' };
  manager.repository = {
    download: async (target, destination, { progress }) => {
      await writeFile(destination, 'fake-archive');
      progress(1024, 1024);
    },
  };
  manager.extract = async (archive, destination) => {
    await copyFile(FAKE_CORE, destination);
    await chmod(destination, 0o555);
  };
  const response = await manager.startJob('install', entry.id);
  assert.equal(response.job.state, 'running');
  await assert.rejects(() => manager.startJob('activate', entry.id), /已有 Core 操作/);
  await assert.rejects(() => manager.startCore(), /已有 Core 操作/);
  await manager.jobTask;
  assert.equal(manager.job.state, 'success', `安装任务失败：${manager.job.message}`);
  const installed = (await manager.status()).versions.installed.find(item => item.id === entry.id);
  assert.equal(installed.version, 'v1.19.33');
  assert.equal(installed.size, 1024);
  const metadata = JSON.parse(await readFile(path.join(manager.installedDir, entry.id, 'metadata.json'), 'utf8'));
  assert.equal(metadata.verified, true);
  assert.equal(metadata.sha256, 'b'.repeat(64));
  assert.equal(metadata.arch, 'x86_64');
});

test('备用来源条目安装时下载后计算 SHA256', async t => {
  const { manager } = await setup(t);
  const entry = {
    id: 'metacubex-stable-v1.19.33-x86_64', channel: 'metacubex-stable', channelLabel: '稳定版',
    version: 'v1.19.33', tag: 'v1.19.33', build: '', arch: 'x86_64', name: 'mihomo-linux-amd64-v1.19.33.gz',
    url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33/mihomo-linux-amd64-v1.19.33.gz',
    sha256: '', size: null, verified: false, fallback: true, risk: false,
    source: 'https://github.com/MetaCubeX/mihomo', repository: 'MetaCubeX/mihomo', license: 'GPL-3.0',
  };
  manager.available = { channel: 'metacubex-stable', entries: [entry], checkedAt: new Date().toISOString(), error: '', fallback: true };
  manager.repository = {
    downloadUnverified: async (target, destination) => {
      await writeFile(destination, 'fallback-archive');
      return { size: 16, sha256: 'c'.repeat(64) };
    },
  };
  manager.extract = async (archive, destination) => {
    await copyFile(FAKE_CORE, destination);
    await chmod(destination, 0o555);
  };
  await manager.startJob('install', entry.id);
  await manager.jobTask;
  assert.equal(manager.job.state, 'success', manager.job.message);
  const metadata = JSON.parse(await readFile(path.join(manager.installedDir, entry.id, 'metadata.json'), 'utf8'));
  assert.equal(metadata.verified, false);
  assert.equal(metadata.fallback, true);
  assert.equal(metadata.sha256, 'c'.repeat(64));
});

test('端口被占用时拒绝启动并给出明确错误', async t => {
  const port = 23462;
  const { manager } = await setup(t);
  await addFakeCore(manager, 'installed-one');
  await activateManually(manager, 'installed-one');
  await manager.config.save(configSource(port));
  const blocker = createServer();
  await new Promise(resolve => blocker.listen({ host: '127.0.0.1', port }, resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  await assert.rejects(() => manager.startCore(), /已被其他程序占用/);
  assert.equal((await manager.status()).core.state, 'stopped');
});

test('崩溃后按设置自动重启 Core', async t => {
  const { manager, controlFile } = await startedManager(t, 23463);
  const firstPid = manager.core.pid;
  await writeFile(controlFile, JSON.stringify({}));
  process.kill(firstPid, 'SIGKILL');
  await waitFor(() => manager.coreState === 'error');
  await waitFor(() => manager.coreState === 'running' && manager.core?.pid && manager.core.pid !== firstPid, 15000);
  assert.equal((await manager.status()).core.state, 'running');
});

test('不完整的版本目录可被删除，启动时会自动清理', async t => {
  const { manager } = await setup(t);
  const broken = path.join(manager.installedDir, 'metacubex-stable-v1.0.0-broken-x86_64');
  await mkdir(broken, { recursive: true });
  await writeFile(path.join(broken, 'mihomo'), 'incomplete');
  const versions = (await manager.status()).versions;
  assert.equal(versions.installed.find(item => item.id === 'metacubex-stable-v1.0.0-broken-x86_64').invalid, true);
  await manager.startJob('remove', 'metacubex-stable-v1.0.0-broken-x86_64');
  await manager.jobTask;
  assert.equal(manager.job.state, 'success', `删除失败：${manager.job.message}`);
  await assert.rejects(() => readFile(path.join(broken, 'mihomo')), { code: 'ENOENT' });

  const orphan = path.join(manager.installedDir, 'metacubex-stable-v1.0.0-orphan-x86_64');
  await mkdir(orphan, { recursive: true });
  await writeFile(path.join(orphan, 'mihomo'), 'orphan');
  const second = new ClashManager(manager.root, { appRoot: path.join(manager.root, 'missing-app'), platform: 'linux', arch: 'x64' });
  await second.init();
  await second.close();
  await assert.rejects(() => readFile(path.join(orphan, 'mihomo')), { code: 'ENOENT' });
});

test('内置 Geo 数据复制到私有运行目录', async t => {
  const { base, manager } = await setup(t);
  const appRoot = path.join(base, 'app');
  const geoRoot = path.join(appRoot, 'cores', 'geo');
  await mkdir(geoRoot, { recursive: true });
  await writeFile(path.join(geoRoot, 'geoip.dat'), 'geoip-data');
  await writeFile(path.join(geoRoot, 'geosite.dat'), 'geosite-data');
  manager.packageMetadata = { geodata: { files: { 'geoip.dat': {}, 'geosite.dat': {} } } };
  await manager.ensureGeodata();
  assert.equal(await readFile(path.join(manager.runtimeDir, 'geoip.dat'), 'utf8'), 'geoip-data');
  assert.equal(await readFile(path.join(manager.runtimeDir, 'geosite.dat'), 'utf8'), 'geosite-data');
});

test('GitHub 加速地址返回 403 时回退直连', async t => {
  const { manager } = await setup(t);
  manager.state.githubMirror = 'https://ghfast.top/';
  const seen = [];
  manager.fetcher = async url => {
    seen.push(url);
    return url.startsWith('https://ghfast.top/')
      ? { status: 403, body: { cancel() {} } }
      : { status: 200, body: null };
  };
  const response = await manager.githubFetcher('https://github.com/a/b', {});
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ['https://ghfast.top/https://github.com/a/b', 'https://github.com/a/b']);
});

test('外部数据设置与同步写入运行时目录', async t => {
  const { manager } = await setup(t);
  const saved = await manager.saveDataSettings({ autoUpdate: true, intervalHours: 12, model: 'middle', urls: { geoip: 'https://example.com/geoip.dat' } });
  assert.equal(saved.settings.autoUpdate, true);
  assert.equal(saved.settings.intervalHours, 12);
  assert.match(saved.settings.urls.model, /Model-middle\.bin$/);
  manager.githubFetcher = async () => ({ ok: true, body: (async function* () { yield Buffer.from('geo-data'); })() });
  const result = await manager.syncData('geoip', { restart: false });
  assert.equal(result.size, 8);
  assert.equal(await readFile(path.join(manager.runtimeDir, 'geoip.dat'), 'utf8'), 'geo-data');
  await assert.rejects(() => manager.saveDataSettings({ intervalHours: 0 }), /1–720/);
});

test('网络诊断返回配置、局域网地址和排查提示', async t => {
  const { manager } = await startedManager(t, 23465);
  const report = await manager.diagnostics();
  assert.equal(report.core.running, true);
  assert.equal(report.config.ports.mixed, 23465);
  assert.ok(Array.isArray(report.network.addresses));
  assert.ok(Array.isArray(report.network.checks));
  assert.ok(report.hints.some(item => /allow-lan/.test(item)));
  assert.equal(typeof report.network.lanReachable, 'boolean');
});

test('应用设置接管端口与 allow-lan 并重启生效', async t => {
  const { manager } = await startedManager(t, 23470);
  assert.equal((await manager.status()).settings.mixedPort, 23470);
  await manager.setSettings({ mixedPort: 23471, httpPort: 0, socksPort: 1081, allowLan: true });
  const status = await manager.status();
  assert.equal(status.settings.mixedPort, 23471);
  assert.equal(status.settings.socksPort, 1081);
  assert.equal(status.settings.allowLan, true);
  assert.equal(status.core.ports.mixed, 23471);
  assert.equal(status.core.ports.socks, 1081);
  const runtime = await readFile(manager.runtimeConfigPath, 'utf8');
  assert.match(runtime, /mixed-port: 23471/);
  assert.match(runtime, /socks-port: 1081/);
  assert.match(runtime, /allow-lan: true/);
  await assert.rejects(() => manager.setSettings({ mixedPort: 23471, socksPort: 23471 }), /SOCKS 端口不能与其他端口相同/);
});

test('代理提供商来自配置 proxy-providers', async t => {
  const { manager } = await setup(t);
  await addFakeCore(manager, 'installed-one');
  await activateManually(manager, 'installed-one');
  await manager.config.save(`${configSource(23472)}proxy-providers:\n  airport:\n    type: http\n    url: https://example.com/sub\n    interval: 3600\n`);
  await manager.startCore();
  const data = await manager.proxies();
  assert.deepEqual(data.providers.map(item => ({ name: item.name, type: item.type, count: item.count })), [{ name: 'airport', type: 'http', count: 1 }]);
  assert.equal(data.providers[0].proxies[0], 'Provider Node');
  assert.equal(data.proxies['Provider Node'].delay, 88);
  await manager.refreshProvider('airport');
});

test('TUN 开关写入配置并重启内核', async t => {
  const { manager } = await startedManager(t, 23466);
  manager.serviceHelperReady = async () => true;
  manager.tunStatus = async () => {
    const info = (await manager.readConfig()).info;
    return { configured: info.tunEnabled, active: info.tunEnabled, device: 'Meta', tunDevicePresent: true, capability: { known: true, capNetAdmin: true, root: false }, message: '' };
  };
  await manager.setTun(true);
  assert.equal((await manager.readConfig()).info.tunEnabled, true);
  assert.equal((await manager.status()).environment.tunEnabled, true);
  assert.equal((await manager.status()).core.state, 'running');
  await manager.setTun(false);
  assert.equal((await manager.readConfig()).info.tunEnabled, false);
  assert.equal((await manager.status()).environment.tunEnabled, false);
});

test('TUN 未创建网卡时回滚配置并报错', async t => {
  const { manager } = await startedManager(t, 23469);
  manager.serviceHelperReady = async () => true;
  manager.tunStatus = async () => ({ configured: false, active: false, device: 'Meta', tunDevicePresent: true, capability: { known: true, capNetAdmin: false, root: false }, message: '内核进程缺少 CAP_NET_ADMIN' });
  await assert.rejects(() => manager.setTun(true), /增强模式未生效：内核进程缺少 CAP_NET_ADMIN/);
  assert.equal((await manager.readConfig()).info.tunEnabled, false);
  assert.equal((await manager.status()).core.state, 'running');
});

test('连通性测试按系统代理状态执行并返回 HTTP 状态', async t => {
  const { manager } = await setup(t);
  manager.systemProxyState = async () => ({ enabled: true, port: 23471 });
  manager.run = async (binary, args, options = {}) => {
    assert.equal(binary, 'curl');
    assert.ok(args.includes('-x'));
    assert.ok(args.includes('http://127.0.0.1:23471'));
    assert.equal(args.at(-1), 'https://example.com/');
    assert.equal(options.timeout, 20000);
    return '204 0.123';
  };
  const result = await manager.testUrl('https://example.com');
  assert.equal(result.ok, true);
  assert.equal(result.code, '204');
  assert.equal(result.proxy.port, 23471);
  await assert.rejects(() => manager.testUrl('file:///etc/passwd'), /只支持 HTTP\/HTTPS/);
  manager.systemProxyState = async () => ({ enabled: false, port: 0 });
  manager.tunStatus = async () => ({ active: true });
  const skipped = await manager.testUrl('https://example.com');
  assert.equal(skipped.skipped, true);
});

test('系统代理状态读取 /etc/environment', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clash-proxy-env-'));
  const envFile = path.join(base, 'environment');
  const { manager } = await setup(t, { systemEnvironmentFile: envFile });
  await addFakeCore(manager, 'installed-one');
  await activateManually(manager, 'installed-one');
  await manager.config.save(configSource(23467));
  await writeFile(envFile, 'http_proxy=http://127.0.0.1:23467\nhttps_proxy=http://127.0.0.1:23467\n');
  assert.equal((await manager.status()).environment.systemProxy, true);
  await writeFile(envFile, 'http_proxy=http://127.0.0.1:9999\n');
  assert.equal((await manager.status()).environment.systemProxy, false);
  await rm(base, { recursive: true, force: true });
});

test('密码提权通过 sudo -S 调用 helper 并回读状态', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clash-sudo-pw-'));
  const envFile = path.join(base, 'environment');
  const helperDir = path.join(base, 'helpers');
  const { manager } = await setup(t, { systemEnvironmentFile: envFile, privilegedHelperDir: helperDir });
  manager.privilegedRun = async (helper, args, { password = '' } = {}) => {
    assert.equal(password, 'secret-pass');
    return manager.run(helper, args, { input: `${password}\n` });
  };
  await mkdir(helperDir, { recursive: true });
  const helper = path.join(helperDir, 'system-proxy');
  await writeFile(helper, `#!/bin/sh\nread -r line\ncase "$line" in secret-pass) printf 'http_proxy=http://127.0.0.1:%s\\n' "$2" > '${envFile}' ;; *) echo 'incorrect password' >&2; exit 1 ;; esac\n`);
  await chmod(helper, 0o755);
  manager.coreState = 'running';
  await manager.setSystemProxy(true, { password: 'secret-pass' });
  assert.equal((await manager.status()).environment.systemProxy, true);
  await rm(base, { recursive: true, force: true });
});

test('服务模式初始化通过密码 sudo 安装 helper', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clash-init-svc-'));
  const helperDir = path.join(base, 'helpers');
  const { manager, appRoot } = await setup(t, { privilegedHelperDir: helperDir });
  await mkdir(path.join(appRoot, 'bin'), { recursive: true });
  await writeFile(path.join(appRoot, 'bin', 'setup-privileges'), '#!/bin/sh\n', { mode: 0o755 });
  manager.privilegedRun = async (helper, args, { password = '', user = '', allowPackageOwned = false } = {}) => {
    assert.equal(password, 'secret-pass');
    assert.equal(user, '');
    assert.equal(allowPackageOwned, true);
    assert.match(args[0], /target$/);
    // simulate setup-privileges installing helpers
    await mkdir(helperDir, { recursive: true });
    await writeFile(path.join(helperDir, 'system-proxy'), '#!/bin/sh\n');
    await writeFile(path.join(helperDir, 'core-caps'), '#!/bin/sh\n');
    await chmod(path.join(helperDir, 'system-proxy'), 0o755);
    await chmod(path.join(helperDir, 'core-caps'), 0o755);
  };
  await manager.initializeServiceMode({ password: 'secret-pass' });
  assert.ok(await manager.serviceHelperReady());
  await rm(base, { recursive: true, force: true });
});

test('服务模式初始化允许包用户组可写的受控脚本', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clash-init-mode-'));
  const helperDir = path.join(base, 'helpers');
  const { manager, appRoot } = await setup(t, { privilegedHelperDir: helperDir });
  const script = path.join(appRoot, 'bin', 'setup-privileges');
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, '#!/bin/sh\n', { mode: 0o775 });
  await chmod(script, 0o775);
  manager.runAsLoginUser = async () => 'ok';
  manager.serviceHelperReady = async () => true;
  await manager.initializeServiceMode({ password: 'secret-pass', user: 'admin' });
  await rm(base, { recursive: true, force: true });
});

test('系统代理开关执行辅助脚本并回读状态', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clash-proxy-toggle-'));
  const envFile = path.join(base, 'environment');
  const helperDir = path.join(base, 'helpers');
  const { manager } = await setup(t, { systemEnvironmentFile: envFile, privilegedHelperDir: helperDir });
  await mkdir(helperDir, { recursive: true });
  const helper = path.join(helperDir, 'system-proxy');
  await writeFile(helper, `#!/bin/sh\nif [ "$1" = enable ]; then printf 'http_proxy=http://127.0.0.1:%s\\n' "$2" > '${envFile}'; else : > '${envFile}'; fi\n`);
  await chmod(helper, 0o755);
  await manager.config.save(configSource(23468));
  manager.coreState = 'running';
  await manager.setSystemProxy(true);
  assert.equal((await manager.status()).environment.systemProxy, true);
  await manager.setSystemProxy(false);
  assert.equal((await manager.status()).environment.systemProxy, false);
  await rm(base, { recursive: true, force: true });
});

test('停止内核恢复系统代理，重新启动按设置自动开启', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'clash-proxy-auto-'));
  const envFile = path.join(base, 'environment');
  const helperDir = path.join(base, 'helpers');
  const { manager } = await startedManager(t, 23472, { systemEnvironmentFile: envFile, privilegedHelperDir: helperDir });
  await mkdir(helperDir, { recursive: true });
  const helper = path.join(helperDir, 'system-proxy');
  await writeFile(helper, `#!/bin/sh\nif [ "$1" = enable ]; then printf 'http_proxy=http://127.0.0.1:%s\\n' "$2" > '${envFile}'; else : > '${envFile}'; fi\n`);
  await chmod(helper, 0o755);
  manager.state.autoSystemProxy = true;
  await manager.setSystemProxy(true);
  assert.equal((await manager.status()).environment.systemProxy, true);
  await manager.stopCore();
  assert.equal((await manager.status()).environment.systemProxy, false);
  assert.equal((await manager.status()).environment.systemProxyDesired, true);
  await manager.startCore();
  assert.equal((await manager.status()).environment.systemProxy, true);
  await rm(base, { recursive: true, force: true });
});

test('日志与状态接口不会泄漏 Controller secret', async t => {
  const { manager } = await startedManager(t, 23464);
  const status = await manager.status();
  assert.doesNotMatch(JSON.stringify(status), new RegExp(manager.state.controllerSecret));
  const logText = JSON.stringify(manager.logsHistory());
  assert.doesNotMatch(logText, new RegExp(manager.state.controllerSecret));
  assert.match(status.core.activeId, /installed-one/);
});

test('首次启动下载外部数据时提供准备进度与字节进度', async t => {
  const { manager } = await setup(t, { bootstrapData: true });
  await addFakeCore(manager, 'installed-one');
  await activateManually(manager, 'installed-one');
  await manager.config.save(configSource(23473));
  const requested = [];
  manager.githubFetcher = async url => {
    requested.push(String(url));
    const body = (async function* () {
      for (let index = 0; index < 4; index += 1) {
        await sleep(30);
        yield Buffer.alloc(8);
      }
    })();
    return { ok: true, headers: new Map([['content-length', '32']]), body };
  };

  const startup = manager.startCore();
  await waitFor(() => {
    const snapshot = manager.preparationSnapshot();
    return snapshot.active && snapshot.steps.some(step => step.state === 'active');
  });
  const during = manager.preparationSnapshot();
  assert.equal(during.active, true);
  assert.equal(during.label, '启动内核');
  assert.ok(during.steps.some(step => step.label === '准备外部数据'));
  await waitFor(() => manager.preparationSnapshot().received > 0);
  const bytes = manager.preparationSnapshot();
  assert.equal(bytes.bytesTotal, 32);
  assert.ok(bytes.received > 0 && bytes.received <= 32);

  await startup;
  const finished = manager.preparationSnapshot();
  assert.equal(finished.active, false);
  assert.equal(finished.error, '');
  assert.ok(finished.steps.every(step => step.state === 'done'));
  assert.ok(requested.length >= 2, 'GeoIP 与 GeoSite 各下载一次');
  assert.equal((await manager.dataReadiness()).ready, true);
  assert.equal((await manager.status()).preparation.active, false);
});
