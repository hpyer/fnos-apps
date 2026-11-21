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
