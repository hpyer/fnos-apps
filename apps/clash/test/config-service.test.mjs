import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigService, isPrivateAddress, defaultConfig, validateSubscriptionUrl } from '../src/config-service.mjs';

const SUBSCRIPTION = `mixed-port: 7890
mode: rule
proxies: []
proxy-groups: []
rules:
  - MATCH,DIRECT
`;

function fetcher(text = SUBSCRIPTION) {
  const calls = [];
  const fn = async url => {
    calls.push(String(url));
    return new Response(text, { status: 200, headers: { etag: '"abc"', 'content-type': 'text/yaml' } });
  };
  fn.calls = calls;
  return fn;
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clash-config-'));
  const service = new ConfigService({
    root, socketPath: path.join(root, 'runtime/controller.sock'), secret: 's'.repeat(48), logLevel: 'info',
    fetcher: options.fetcher || fetcher(),
    resolver: options.resolver || (async () => [{ address: '93.184.216.34' }]),
    ...options.service,
  });
  await service.init();
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, service };
}

test('首次初始化创建私有默认配置', async t => {
  const { root, service } = await fixture(t);
  const config = await service.read();
  assert.equal(config.source, defaultConfig());
  assert.equal((await stat(path.join(root, 'config/config.yaml'))).mode & 0o777, 0o600);
  assert.equal(config.kind, 'default');
});

test('保存配置前备份，恢复备份生效', async t => {
  const { service } = await fixture(t);
  await service.save('mixed-port: 7890\nmode: rule\nproxies: []\nrules:\n  - MATCH,DIRECT\n', { kind: 'manual' });
  const backups = await service.listBackups();
  assert.equal(backups.length, 1);
  await service.save('mixed-port: 7891\nmode: global\nproxies: []\nrules:\n  - MATCH,DIRECT\n');
  const restored = await service.restoreBackup(backups[0].id);
  assert.match(restored.source, /7890/);
  assert.equal((await service.read()).kind, 'restore');
  await assert.rejects(() => service.restoreBackup('../etc/passwd'), /无效/);
  const beforeDelete = await service.listBackups();
  await service.deleteBackup(beforeDelete[0].id);
  assert.equal((await service.listBackups()).length, beforeDelete.length - 1);

  const backupCount = (await service.listBackups()).length;
  const current = await service.source();
  const unchanged = await service.save(current);
  assert.equal(unchanged.unchanged, true);
  assert.equal((await service.listBackups()).length, backupCount, '相同配置不新增备份');
});

test('订阅添加、掩码、下载、应用与删除', async t => {
  const download = fetcher();
  const { service } = await fixture(t, { fetcher: download });
  const added = await service.addSubscription({ name: '家庭订阅', url: 'https://sub.example.com/api?token=secret-token', intervalHours: 6 });
  assert.equal(added.name, '家庭订阅');
  assert.match(added.urlMasked, /sub\.example\.com\/api\?\*\*\*/);
  assert.doesNotMatch(JSON.stringify(service.listSubscriptions()), /secret-token/);
  assert.equal((await readdir(path.join(service.root, 'backups'))).length, 0);

  assert.equal(download.calls.length, 1, '添加订阅会立即下载一次内容');
  assert.ok(added.updatedAt, '初始下载成功后记录更新时间');
  const updated = await service.updateSubscription(added.id);
  assert.equal(updated.name, '家庭订阅');
  assert.equal(updated.size, Buffer.byteLength(SUBSCRIPTION));
  assert.equal(download.calls.length, 2);
  const applied = await service.applySubscription(added.id);
  assert.equal(applied.kind, 'subscription');
  assert.equal(applied.subscriptionId, added.id);
  assert.match((await readFile(path.join(service.root, 'subscriptions', `${added.id}.yaml`), 'utf8')), /MATCH,DIRECT/);
  assert.equal(service.listSubscriptions()[0].applied, true);
  await service.deleteSubscription(added.id);
  assert.equal(service.listSubscriptions().length, 0);
});

test('拒绝不合法订阅、内网目标与无效内容', async t => {
  const { service } = await fixture(t);
  await assert.rejects(() => service.addSubscription({ name: '', url: 'https://a.example/x' }), /订阅名称/);
  await assert.rejects(() => service.addSubscription({ name: 'n', url: 'http://a.example/x' }), /HTTPS/);
  await assert.rejects(() => service.addSubscription({ name: 'n', url: 'https://u:p@a.example/x' }), /用户名或密码/);
  assert.throws(() => validateSubscriptionUrl('ftp://a.example/x'), /HTTPS/);
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.1.2.3'), true);
  assert.equal(isPrivateAddress('192.168.1.1'), true);
  assert.equal(isPrivateAddress('172.20.1.1'), true);
  assert.equal(isPrivateAddress('fc00::1'), true);
  assert.equal(isPrivateAddress('fe80::1'), true);
  assert.equal(isPrivateAddress('198.18.0.1'), false, 'fake-ip / benchmark 段不属于内网服务');
  assert.equal(isPrivateAddress('198.19.255.1'), false);
  assert.equal(isPrivateAddress('93.184.216.34'), false);

  const added = await service.addSubscription({ name: 'bad', url: 'https://bad.example.com/sub' });
  const invalid = new ConfigService({ root: path.join(service.root, 'other'), socketPath: path.join(service.root, 'other/runtime/s.sock'), secret: 'x'.repeat(48), fetcher: fetcher('not a configuration'), resolver: async () => [{ address: '93.184.216.34' }] });
  await invalid.init();
  const bad = await invalid.addSubscription({ name: 'bad', url: 'https://bad.example.com/sub' });
  await assert.rejects(() => invalid.updateSubscription(bad.id), /无法识别配置结构/);
  assert.match(invalid.listSubscriptions()[0].lastError, /无法识别配置结构/);
});

test('内网域名解析结果被拒绝', async t => {
  const { service } = await fixture(t, { resolver: async () => [{ address: '10.0.0.5' }] });
  const added = await service.addSubscription({ name: 'lan', url: 'https://lan.example.com/sub' });
  await assert.rejects(() => service.updateSubscription(added.id), /内网|回环/);
  const loopback = await service.addSubscription({ name: 'loopback', url: 'https://127.0.0.1/sub' });
  await assert.rejects(() => service.updateSubscription(loopback.id), /内网|回环/);
});
