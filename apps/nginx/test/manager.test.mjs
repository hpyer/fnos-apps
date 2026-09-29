import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NginxManager, serverOnly, siteName, notificationSettings } from '../src/manager.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fnos-nginx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new NginxManager(root, { run: async () => 'nginx test is successful', ...options });
  await manager.init();
  manager.state.activeVersion = '1.28.0';
  return manager;
}

test('站点文件仅接受顶层 server 块且阻止路径穿越', () => {
  assert.equal(serverOnly('# 说明\nserver { location / { return 200 "}"; } }\nserver { listen 8080; }').includes('server'), true);
  assert.throws(() => serverOnly('http { server { listen 80; } }'), /顶层/);
  assert.throws(() => serverOnly('include elsewhere.conf;\nserver { listen 80; }'), /顶层/);
  assert.throws(() => siteName('../bad.conf'), /文件名/);
});

test('重启只允许运行中的 Nginx，并按停止、启动顺序执行', async t => {
  const manager = await fixture(t);
  await assert.rejects(manager.restart(), /未运行/);
  manager.child = { pid: process.pid };
  const calls = [];
  manager.stop = async () => { calls.push('stop'); };
  manager.start = async () => { calls.push('start'); };
  await manager.restart();
  assert.deepEqual(calls, ['stop', 'start']);
});

test('候选配置验证失败不会覆盖线上站点文件', async t => {
  const manager = await fixture(t);
  assert.doesNotMatch(await manager.readConfig(), /^user /);
  await manager.saveSite('example.conf', 'server { listen 8080; }');
  manager.run = async (_binary, args) => {
    const conf = await readFile(args[args.indexOf('-c') + 1], 'utf8');
    const include = conf.match(/include ([^;]+)\/\*\.conf;/)?.[1];
    if (include && (await readFile(path.join(include, 'example.conf'), 'utf8')).includes('bad-upstream')) throw Error('nginx: 配置验证失败');
    return 'ok';
  };
  await assert.rejects(manager.saveSite('example.conf', 'server { listen 8080; # bad-upstream\n }'), /配置验证失败/);
  assert.equal(await manager.listSite('example.conf'), 'server { listen 8080; }');
});

test('站点可禁用、编辑并在候选配置校验通过后重新启用', async t => {
  const manager = await fixture(t);
  await manager.saveSite('beta.conf', 'server { listen 8082; }');
  await manager.saveSite('alpha.conf', 'server { listen 8081; }');
  assert.deepEqual((await manager.status()).sites, ['alpha.conf', 'beta.conf']);
  assert.deepEqual((await manager.status()).disabledSites, []);

  await manager.setSiteEnabled('alpha.conf', false);
  assert.deepEqual((await manager.status()).sites, ['beta.conf']);
  assert.deepEqual((await manager.status()).disabledSites, ['alpha.conf']);
  await assert.rejects(readFile(path.join(manager.sites, 'alpha.conf'), 'utf8'), { code: 'ENOENT' });
  assert.equal(await manager.listSite('alpha.conf'), 'server { listen 8081; }');
  await manager.saveSite('alpha.conf', 'server { listen 8181; }');
  assert.equal(await readFile(path.join(manager.sites, 'alpha.conf.disabled'), 'utf8'), 'server { listen 8181; }');
  assert.deepEqual((await manager.status()).disabledSites, ['alpha.conf']);

  manager.run = async (_binary, args) => {
    const conf = await readFile(args[args.indexOf('-c') + 1], 'utf8');
    const candidateSites = conf.match(/include ([^;]+)\/\*\.conf;/)?.[1];
    assert.equal(await readFile(path.join(candidateSites, 'alpha.conf'), 'utf8'), 'server { listen 8181; }');
    await assert.rejects(readFile(path.join(manager.sites, 'alpha.conf'), 'utf8'), { code: 'ENOENT' });
    return 'ok';
  };
  await manager.setSiteEnabled('alpha.conf', true);
  assert.deepEqual((await manager.status()).sites, ['alpha.conf', 'beta.conf']);
  assert.deepEqual((await manager.status()).disabledSites, []);
  await assert.rejects(readFile(path.join(manager.sites, 'alpha.conf.disabled'), 'utf8'), { code: 'ENOENT' });
});

test('站点状态切换失败会回滚，禁用站点可删除', async t => {
  const manager = await fixture(t);
  await manager.saveSite('example.conf', 'server { listen 8080; }');
  manager.child = { pid: process.pid };
  manager.reload = async () => { throw Error('重载失败'); };
  await assert.rejects(manager.setSiteEnabled('example.conf', false), /重载失败/);
  assert.deepEqual((await manager.status()).sites, ['example.conf']);

  manager.child = null;
  await manager.setSiteEnabled('example.conf', false);
  manager.run = async () => { throw Error('配置验证失败'); };
  await assert.rejects(manager.setSiteEnabled('example.conf', true), /配置验证失败/);
  assert.deepEqual((await manager.status()).disabledSites, ['example.conf']);
  manager.run = async () => 'ok';
  manager.child = { pid: process.pid };
  await assert.rejects(manager.setSiteEnabled('example.conf', true), /重载失败/);
  assert.deepEqual((await manager.status()).disabledSites, ['example.conf']);
  await manager.deleteSite('example.conf');
  assert.deepEqual((await manager.status()).disabledSites, []);
});

test('主配置先校验候选文件，失败保留原配置，重载失败回滚', async t => {
  const manager = await fixture(t);
  const original = await manager.readConfig();
  const edited = original.replace('worker_processes auto;', 'worker_processes 2;');
  let validated = 0;
  manager.run = async (_binary, args) => {
    const file = args[args.indexOf('-c') + 1];
    const candidate = await readFile(file, 'utf8');
    assert.equal(await manager.readConfig(), original);
    assert.notEqual(file, manager.config);
    validated++;
    if (candidate.includes('bad_directive;')) throw Error('nginx: 配置验证失败');
    return 'ok';
  };
  await assert.rejects(manager.saveConfig(edited.replace(`include ${manager.sites}/*.conf;`, '')), /须保留/);
  await assert.rejects(manager.saveConfig(edited.replace('worker_processes 2;', 'bad_directive;')), /配置验证失败/);
  assert.equal(await manager.readConfig(), original);
  assert.equal(validated, 1);

  manager.child = { pid: process.pid };
  manager.reload = async () => { throw Error('重载失败'); };
  await assert.rejects(manager.saveConfig(edited), /重载失败/);
  assert.equal(await manager.readConfig(), original);
  manager.child = null;
  assert.deepEqual(await manager.saveConfig(edited), { ok: true });
  assert.equal(await manager.readConfig(), edited);
  assert.match(manager.state.lastResult, /已保存主配置/);

  const updated = edited.replace('worker_processes 2;', 'worker_processes 3;');
  manager.run = async (_binary, args) => {
    assert.equal(await readFile(args[args.indexOf('-c') + 1], 'utf8'), updated);
    return 'ok';
  };
  let reloads = 0;
  manager.child = { pid: process.pid };
  manager.reload = async () => { reloads++; assert.equal(await manager.readConfig(), updated); };
  await manager.saveConfig(updated);
  assert.equal(reloads, 1);
});

test('候选站点配置使用可写的应用临时目录，清理后校验会重新创建', async t => {
  const manager = await fixture(t);
  await rm(manager.temp, { recursive: true, force: true });
  manager.run = async (_binary, args) => {
    const config = await readFile(args[args.indexOf('-c') + 1], 'utf8');
    for (const [directive, directory] of [
      ['client_body_temp_path', 'client_body'], ['proxy_temp_path', 'proxy'],
      ['fastcgi_temp_path', 'fastcgi'], ['uwsgi_temp_path', 'uwsgi'], ['scgi_temp_path', 'scgi']
    ]) {
      assert.ok(config.includes(`${directive} ${path.join(manager.temp, directory)};`));
      assert.equal((await stat(path.join(manager.temp, directory))).mode & 0o777, 0o700);
    }
    return 'nginx: configuration file test is successful';
  };
  await manager.saveSite('new.conf', 'server { listen 8083; }');
});

test('共享临时目录中的软链接不会被当作 worker 目录修改', async t => {
  const manager = await fixture(t);
  const external = path.join(manager.root, 'external');
  await mkdir(external, { mode: 0o755 });
  await rm(path.join(manager.temp, 'proxy'), { recursive: true });
  await symlink(external, path.join(manager.temp, 'proxy'));
  await assert.rejects(manager.validate(), { code: 'ENOTDIR' });
  assert.equal((await stat(external)).mode & 0o777, 0o755);
});

test('通知文件测试会创建文件且测试内容不触发重载', async t => {
  const manager = await fixture(t);
  const file = path.join(manager.root, 'reload.trigger');
  const result = await manager.testNotificationPath(file);
  assert.equal(result.created, true);
  assert.match(await readFile(file, 'utf8'), /^test:/);
  manager.state.notificationEnabled = true;
  manager.state.notificationPath = file;
  let reloads = 0;
  manager.reload = async () => { reloads++; };
  assert.deepEqual(await manager.checkNotification(), { skipped: true });
  await writeFile(file, '20260928T120000Z-123\n');
  const existing = await manager.testNotificationPath(file);
  assert.equal(existing.created, false);
  assert.equal(await readFile(file, 'utf8'), '20260928T120000Z-123\n');
  assert.deepEqual(await manager.checkNotification(), { reloaded: true });
  const handledAt = manager.state.lastHandledAt;
  assert.equal(manager.state.lastHandled, '20260928T120000Z-123');
  assert.ok(Number.isFinite(Date.parse(handledAt)));
  assert.equal((await manager.status()).lastHandledAt, handledAt);
  assert.deepEqual(await manager.checkNotification(), { skipped: true });
  assert.equal(manager.state.lastHandledAt, handledAt);
  await writeFile(file, '20260928T130000Z-123\n');
  manager.reload = async () => { throw Error('reload failed'); };
  await assert.rejects(manager.checkNotification(), /reload failed/);
  assert.equal(manager.state.lastHandled, '20260928T120000Z-123');
  assert.equal(manager.state.lastHandledAt, handledAt);
  assert.equal(reloads, 1);
});

test('官方版本下载后校验架构，安装失败不保留版本目录', async t => {
  const repository = { latest: async () => ({ version: '1.30.5', packageVersion: '1.30.5-1~bookworm', channel: 'stable', distribution: 'debian bookworm / amd64' }), download: async (_entry, target) => writeFile(target, 'deb') };
  const manager = await fixture(t, { platform: 'linux', arch: 'x64', repository });
  manager.run = async (binary, args) => {
    if (binary === 'dpkg-deb') {
      await mkdir(path.join(args[2], 'usr/sbin'), { recursive: true });
      const bad = Buffer.alloc(20); Buffer.from('7f454c46', 'hex').copy(bad); bad[4] = 2; bad[5] = 1; bad.writeUInt16LE(183, 18);
      await writeFile(path.join(args[2], 'usr/sbin/nginx'), bad); return '';
    }
    return 'nginx version: nginx/1.30.5';
  };
  await assert.rejects(manager.installOfficial('stable'), /架构不匹配/);
  const binary = Buffer.alloc(20);
  Buffer.from('7f454c46', 'hex').copy(binary);
  binary[4] = 2; binary[5] = 1;
  binary.writeUInt16LE(62, 18);
  manager.run = async (command, args) => {
    if (command === 'dpkg-deb') {
      await mkdir(path.join(args[2], 'usr/sbin'), { recursive: true });
      await writeFile(path.join(args[2], 'usr/sbin/nginx'), binary); return '';
    }
    return 'nginx version: nginx/1.30.5';
  };
  const installed = await manager.installOfficial('stable');
  assert.equal(installed.version, '1.30.5');
  assert.equal(installed.autoActivated, false);
  assert.equal(manager.state.activeVersion, '1.28.0');
  await assert.rejects(manager.installOfficial('stable'), /已安装/);
});

test('首次安装自动启用，失败时保留下载版本供重试', async t => {
  let latestVersion = '1.30.5';
  const binary = Buffer.alloc(20);
  Buffer.from('7f454c46', 'hex').copy(binary);
  binary[4] = 2; binary[5] = 1; binary.writeUInt16LE(62, 18);
  const repository = {
    latest: async () => ({ version: latestVersion, packageVersion: `${latestVersion}-1~bookworm`, channel: 'stable', distribution: 'debian bookworm / amd64' }),
    download: async (_entry, target) => writeFile(target, 'deb')
  };
  const manager = await fixture(t, { platform: 'linux', arch: 'x64', repository });
  manager.state.activeVersion = '';
  manager.run = async (command, args) => {
    if (command === 'dpkg-deb') {
      await mkdir(path.join(args[2], 'usr/sbin'), { recursive: true });
      await writeFile(path.join(args[2], 'usr/sbin/nginx'), binary); return '';
    }
    if (args.includes('-v')) return `nginx version: nginx/${path.basename(path.dirname(command))}`;
    return 'ok';
  };
  let starts = 0;
  manager.start = async () => { starts++; assert.equal(manager.state.activeVersion, latestVersion); };
  const first = await manager.installOfficial('stable');
  assert.equal(first.autoActivated, true);
  assert.equal(manager.state.activeVersion, '1.30.5');
  assert.equal(starts, 1);

  latestVersion = '1.30.6';
  const second = await manager.installOfficial('stable');
  assert.equal(second.autoActivated, false);
  assert.equal(manager.state.activeVersion, '1.30.5');
  assert.equal(starts, 1);

  manager.state.activeVersion = '';
  latestVersion = '1.30.7';
  manager.start = async () => { throw Error('端口不可用'); };
  const failed = await manager.installOfficial('stable');
  assert.equal(failed.autoActivated, false);
  assert.match(failed.warning, /端口不可用/);
  assert.match(manager.state.lastResult, /自动启用失败：端口不可用/);
  assert.equal(manager.state.activeVersion, '');
  assert.ok((await manager.status()).versions.includes('1.30.7'));
});

test('通知默认关闭且间隔必须有效', () => {
  assert.deepEqual(notificationSettings({ notificationEnabled: false, notificationPath: '', intervalMinutes: 30 }), { notificationEnabled: false, notificationPath: '', intervalMinutes: 30 });
  assert.throws(() => notificationSettings({ notificationEnabled: true, notificationPath: 'relative', intervalMinutes: 30 }), /绝对路径/);
});

test('旧安装迁移到应用共享目录并移除已失效的 user 指令', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'fnos-nginx-migrate-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, '@appdata/nginx-for-fnos');
  const shareRoot = path.join(parent, '@appshare/nginx-for-fnos');
  await mkdir(path.join(root, 'sites'), { recursive: true });
  await mkdir(path.join(root, 'versions/1.30.5'), { recursive: true });
  await mkdir(path.join(root, 'logs'), { recursive: true });
  await writeFile(path.join(root, 'sites/example.conf'), 'server { listen 8080; }');
  await writeFile(path.join(root, 'versions/1.30.5/nginx'), 'trusted binary');
  await writeFile(path.join(root, 'logs/error.log'), 'old log\n');
  await writeFile(path.join(root, 'nginx.conf'), `user nobody;\npid ${root}/nginx.pid;\nerror_log ${root}/logs/error.log warn;\nworker_processes 2;\nevents { worker_connections 512; }\nhttp { include ${root}/sites/*.conf; }\n`);
  await mkdir(shareRoot, { recursive: true, mode: 0o700 });
  await chmod(shareRoot, 0o700);
  const manager = new NginxManager(root, { shareRoot, run: async () => 'nginx: configuration file test is successful' });
  await manager.init();
  assert.equal(await readFile(path.join(shareRoot, 'sites/example.conf'), 'utf8'), 'server { listen 8080; }');
  assert.equal(await readFile(path.join(shareRoot, 'logs/error.log'), 'utf8'), 'old log\n');
  const config = await readFile(manager.config, 'utf8');
  assert.doesNotMatch(config, /^user /);
  assert.match(config, /worker_processes 2;/);
  assert.ok(config.includes(`include ${shareRoot}/sites/*.conf;`));
  assert.ok(config.includes(`error_log ${shareRoot}/logs/error.log`));
  assert.ok(config.includes(`client_body_temp_path ${shareRoot}/temp/client_body;`));
  assert.ok(config.includes(`proxy_temp_path ${shareRoot}/temp/proxy;`));
  await manager.prepareConfig();
  assert.equal((await readFile(manager.config, 'utf8')).match(/client_body_temp_path/g)?.length, 1);
  assert.equal((await stat(shareRoot)).mode & 0o777, 0o700);
  assert.deepEqual(manager.args().slice(2, 4), ['-e', path.join(shareRoot, 'logs/error.log')]);
  await manager.ensureRuntime('1.30.5');
  assert.equal(await readFile(manager.binary('1.30.5'), 'utf8'), 'trusted binary');
  await writeFile(path.join(shareRoot, 'versions/1.30.5/nginx'), 'tampered binary');
  await assert.rejects(manager.ensureRuntime('1.30.5'), /文件已变化/);
});

test('共享目录已有文件时迁移不会覆盖，手工主配置参与站点校验', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'fnos-nginx-share-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, '@appdata/nginx-for-fnos');
  const shareRoot = path.join(parent, '@appshare/nginx-for-fnos');
  await mkdir(path.join(root, 'sites'), { recursive: true });
  await mkdir(path.join(shareRoot, 'sites'), { recursive: true });
  await writeFile(path.join(root, 'sites/example.conf'), 'server { listen 8081; }');
  await writeFile(path.join(shareRoot, 'sites/example.conf'), 'server { listen 8082; }');
  const manager = new NginxManager(root, { shareRoot, run: async (_binary, args) => {
    if (args.includes('-t')) {
      const config = await readFile(args[args.indexOf('-c') + 1], 'utf8');
      assert.match(config, /worker_processes 3;/);
      assert.ok(config.includes('candidate-'));
    }
    return 'ok';
  } });
  await manager.init();
  assert.equal(await readFile(path.join(shareRoot, 'sites/example.conf'), 'utf8'), 'server { listen 8082; }');
  assert.equal(await readFile(path.join(root, 'sites/example.conf'), 'utf8'), 'server { listen 8081; }');
  await writeFile(manager.config, (await readFile(manager.config, 'utf8')).replace('worker_processes auto;', 'worker_processes 3;'));
  manager.state.activeVersion = '1.30.5';
  await manager.saveSite('new.conf', 'server { listen 8083; }');
  assert.match(await readFile(manager.config, 'utf8'), /worker_processes 3;/);
  await writeFile(manager.config, (await readFile(manager.config, 'utf8')).replace(`include ${shareRoot}/sites/*.conf;`, `# include ${shareRoot}/sites/*.conf;`));
  await assert.rejects(manager.saveSite('another.conf', 'server { listen 8084; }'), /须保留/);
});
