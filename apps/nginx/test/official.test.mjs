import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { OfficialRepository, channelName, distribution, parsePackages } from '../src/official.mjs';

const sha = 'a'.repeat(64);
const packageBlock = (version, architecture = 'amd64', hash = sha) => `Package: nginx\nVersion: ${version}\nArchitecture: ${architecture}\nFilename: pool/nginx/n/nginx/nginx_${version}_${architecture}.deb\nSHA256: ${hash}\nSize: 4\n`;

test('仅允许官方通道及明确支持的系统和架构', () => {
  assert.equal(channelName('stable'), 'stable');
  assert.throws(() => channelName('custom'), /稳定版或主线版/);
  assert.deepEqual(distribution('ID=debian\nVERSION_CODENAME=bookworm\n', 'linux', 'x64'), { family: 'debian', codename: 'bookworm', architecture: 'amd64' });
  assert.throws(() => distribution('ID=fnos\nVERSION_CODENAME=bookworm\n', 'linux', 'x64'), /没有可确认兼容/);
});

test('版本索引仅接受 nginx 软件包并选最高上游版本', () => {
  const index = `${packageBlock('1.30.4-1~bookworm')}\n${packageBlock('1.30.5-1~bookworm')}\n${packageBlock('1.99.0-1~bookworm', 'arm64')}`;
  assert.equal(parsePackages(index, 'amd64').version, '1.30.5');
  assert.throws(() => parsePackages(packageBlock('1.30.5-1~bookworm', 'amd64', 'bad'), 'amd64'), /未找到/);
});

test('固定官方仓库地址且下载验证大小和 SHA256', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nginx-official-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = Buffer.from('test');
  const hash = createHash('sha256').update(payload).digest('hex');
  const index = gzipSync(packageBlock('1.30.5-1~bookworm', 'amd64', hash));
  const requests = [];
  const fetcher = async url => {
    requests.push(url);
    const bytes = url.endsWith('Packages.gz') ? index : payload;
    return { ok: true, status: 200, url, body: [bytes] };
  };
  const repository = new OfficialRepository({ fetcher, platform: 'linux', arch: 'x64', osRelease: async () => 'ID=debian\nVERSION_CODENAME=bookworm\n' });
  const latest = await repository.latest('stable');
  assert.equal(latest.version, '1.30.5');
  const target = path.join(root, 'nginx.deb');
  await repository.download(latest, target);
  assert.deepEqual(await readFile(target), payload);
  assert.ok(requests.every(url => url.startsWith('https://nginx.org/packages/debian/')));
  await assert.rejects(repository.download({ ...latest, sha256: sha }, path.join(root, 'bad.deb')), /SHA256/);
});
