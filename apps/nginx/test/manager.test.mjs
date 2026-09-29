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

test('候选配置验证失败不会覆盖线上站点文件', async t => {
  const manager = await fixture(t);
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
  await manager.saveSite('new.conf', 'server { listen 1003; }');
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
  assert.deepEqual(await manager.checkNotification(), { skipped: true });
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
  assert.equal((await manager.installOfficial('stable')).version, '1.30.5');
  await assert.rejects(manager.installOfficial('stable'), /已安装/);
});

test('通知默认关闭且间隔必须有效', () => {
  assert.deepEqual(notificationSettings({ notificationEnabled: false, notificationPath: '', intervalMinutes: 30 }), { notificationEnabled: false, notificationPath: '', intervalMinutes: 30 });
  assert.throws(() => notificationSettings({ notificationEnabled: true, notificationPath: 'relative', intervalMinutes: 30 }), /绝对路径/);
});

test('旧安装迁移到应用共享目录并修复 worker 主组和初始错误日志', async t => {
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
  const calls = [];
  await mkdir(shareRoot, { recursive: true, mode: 0o700 });
  await chmod(shareRoot, 0o700);
  const owners = [];
  const manager = new NginxManager(root, { shareRoot, workerUser: 'nginx_for_fnos', platform: 'linux', uid: 0, setOwner: async (...args) => owners.push(args), run: async (binary, args) => {
    calls.push({ binary, args });
    if (binary === 'id') return args[0] === '-gn' ? args[1] === 'nobody' ? 'nogroup' : '976' : '976';
    return 'nginx: configuration file test is successful';
  } });
  await manager.init();
  assert.equal(await readFile(path.join(shareRoot, 'sites/example.conf'), 'utf8'), 'server { listen 8080; }');
  assert.equal(await readFile(path.join(shareRoot, 'logs/error.log'), 'utf8'), 'old log\n');
  const config = await readFile(manager.config, 'utf8');
  assert.match(config, /^user nginx_for_fnos nogroup;/);
  assert.match(config, /worker_processes 2;/);
  assert.ok(config.includes(`include ${shareRoot}/sites/*.conf;`));
  assert.ok(config.includes(`error_log ${shareRoot}/logs/error.log`));
  assert.ok(config.includes(`client_body_temp_path ${shareRoot}/temp/client_body;`));
  assert.ok(config.includes(`proxy_temp_path ${shareRoot}/temp/proxy;`));
  await manager.prepareConfig();
  assert.equal((await readFile(manager.config, 'utf8')).match(/client_body_temp_path/g)?.length, 1);
  assert.equal((await stat(shareRoot)).mode & 0o001, 0o001);
  assert.equal(owners.length, 5);
  assert.deepEqual(owners[0].slice(1), [976, 976]);
  assert.equal(calls[0].binary, 'id');
  assert.deepEqual(calls[0].args, ['-gn', 'nginx_for_fnos']);
  assert.deepEqual(calls[1].args, ['-gn', 'nobody']);
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
  await writeFile(path.join(root, 'sites/example.conf'), 'server { listen 1001; }');
  await writeFile(path.join(shareRoot, 'sites/example.conf'), 'server { listen 1002; }');
  const manager = new NginxManager(root, { shareRoot, run: async (_binary, args) => {
    if (args.includes('-t')) {
      const config = await readFile(args[args.indexOf('-c') + 1], 'utf8');
      assert.match(config, /worker_processes 3;/);
      assert.ok(config.includes('candidate-'));
    }
    return 'ok';
  } });
  await manager.init();
  assert.equal(await readFile(path.join(shareRoot, 'sites/example.conf'), 'utf8'), 'server { listen 1002; }');
  assert.equal(await readFile(path.join(root, 'sites/example.conf'), 'utf8'), 'server { listen 1001; }');
  await writeFile(manager.config, (await readFile(manager.config, 'utf8')).replace('worker_processes auto;', 'worker_processes 3;'));
  manager.state.activeVersion = '1.30.5';
  await manager.saveSite('new.conf', 'server { listen 1003; }');
  assert.match(await readFile(manager.config, 'utf8'), /worker_processes 3;/);
  await writeFile(manager.config, (await readFile(manager.config, 'utf8')).replace(`include ${shareRoot}/sites/*.conf;`, `# include ${shareRoot}/sites/*.conf;`));
  await assert.rejects(manager.saveSite('another.conf', 'server { listen 1004; }'), /须保留/);
});
