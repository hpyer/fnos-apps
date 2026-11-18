import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CoreRepository, parseRelease } from '../src/repository.mjs';

const SHA_X86 = 'a'.repeat(64);
const SHA_ARM = 'b'.repeat(64);
const BASE = 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33';

function asset(name, size, digest = `sha256:${SHA_X86}`) {
  return { name, size, digest, browser_download_url: `https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33/${name}` };
}

const RELEASE = {
  tag_name: 'v1.19.33',
  draft: false,
  prerelease: false,
  published_at: '2026-11-01T00:00:00Z',
  assets: [
    asset('mihomo-linux-amd64-v1.19.33.gz', 22862419, `sha256:${SHA_X86}`),
    asset('mihomo-linux-arm64-v1.19.33.gz', 20824326, `sha256:${SHA_ARM}`),
    asset('mihomo-linux-amd64-compatible-v1.19.33.gz', 19000000),
    asset('mihomo-linux-amd64-v3-v1.19.33.gz', 23000000),
  ],
};

test('解析稳定版发布，仅接受官方资产名与 SHA256', () => {
  const entries = parseRelease(RELEASE, 'metacubex-stable');
  assert.equal(entries.length, 2);
  const x86 = entries.find(item => item.arch === 'x86_64');
  assert.equal(x86.id, 'metacubex-stable-v1.19.33-x86_64');
  assert.equal(x86.version, 'v1.19.33');
  assert.equal(x86.sha256, SHA_X86);
  assert.equal(x86.size, 19000000);
  assert.equal(x86.name, 'mihomo-linux-amd64-compatible-v1.19.33.gz');
  assert.equal(x86.verified, true);
  assert.equal(entries.find(item => item.arch === 'arm64').id, 'metacubex-stable-v1.19.33-arm64');
});

test('拒绝没有上游 SHA256 或来源不在允许地址的资产', () => {
  const missingDigest = structuredClone(RELEASE);
  delete missingDigest.assets[2].digest;
  const entries = parseRelease(missingDigest, 'metacubex-stable');
  assert.equal(entries.find(item => item.arch === 'x86_64').verified, false);
  assert.equal(entries.find(item => item.arch === 'arm64').verified, true);
  const wrongHost = structuredClone(RELEASE);
  wrongHost.assets[2].browser_download_url = 'https://evil.example/mihomo.gz';
  assert.equal(parseRelease(wrongHost, 'metacubex-stable').length, 1);
  assert.equal(parseRelease({ ...RELEASE, prerelease: true }, 'metacubex-stable').length, 0);
});

test('测试版与 Smart 版采用 alpha 资产命名', () => {
  const alpha = {
    tag_name: 'Prerelease-Alpha', draft: false, prerelease: true, published_at: '2026-11-09T00:00:00Z',
    assets: [
      { name: 'mihomo-linux-amd64-alpha-478af2a.gz', size: 100, digest: `sha256:${SHA_X86}`, browser_download_url: 'https://github.com/MetaCubeX/mihomo/releases/download/Prerelease-Alpha/mihomo-linux-amd64-alpha-478af2a.gz' },
      { name: 'mihomo-linux-arm64-alpha-478af2a.gz', size: 200, digest: `sha256:${SHA_ARM}`, browser_download_url: 'https://github.com/MetaCubeX/mihomo/releases/download/Prerelease-Alpha/mihomo-linux-arm64-alpha-478af2a.gz' },
    ],
  };
  const entries = parseRelease(alpha, 'metacubex-test');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].build, '478af2a');
  assert.equal(entries[0].version, '');
  assert.equal(entries[0].id, 'metacubex-test-478af2a-x86_64');

  const smart = {
    tag_name: 'Prerelease-Alpha', draft: false, prerelease: true, published_at: '2026-11-09T00:00:00Z',
    assets: [{
      name: 'mihomo-linux-amd64-alpha-smart-96feb2a.gz', size: 300, digest: `sha256:${SHA_X86}`,
      browser_download_url: 'https://github.com/vernesong/mihomo/releases/download/Prerelease-Alpha/mihomo-linux-amd64-alpha-smart-96feb2a.gz',
    }],
  };
  const smartEntries = parseRelease(smart, 'smart');
  assert.equal(smartEntries.length, 1);
  assert.equal(smartEntries[0].build, '96feb2a');
  assert.equal(smartEntries[0].id, 'smart-96feb2a-x86_64');
  assert.equal(smartEntries[0].repository, 'vernesong/mihomo');
});

test('目录查询排序、渠道过滤与限流错误映射', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clash-repo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const fetcher = async url => {
    calls.push(String(url));
    return new Response(JSON.stringify([RELEASE]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const repository = new CoreRepository({ fetcher });
  const catalog = await repository.catalog('metacubex-stable');
  assert.equal(catalog.channel, 'metacubex-stable');
  assert.equal(catalog.entries.length, 2);
  assert.match(calls[0], /api\.github\.com\/repos\/MetaCubeX\/mihomo\/releases/);

  const limited = new CoreRepository({ fetcher: async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } }) });
  await assert.rejects(() => limited.catalog('metacubex-stable'), error => error.status === 503 && /限流/.test(error.message));

  const redirector = new CoreRepository({ fetcher: async () => new Response('', { status: 302, headers: { location: 'https://evil.example/x' } }) });
  await assert.rejects(() => redirector.catalog('metacubex-stable'), /允许名单/);
});

test('GitHub API 限流时使用 Atom 与 expanded_assets 备用来源', async () => {
  const atom = `<?xml version="1.0"?><feed>
    <entry><id>tag:github.com,2008:Repository/123456/v1.19.33</id></entry>
    <entry><id>tag:github.com,2008:Repository/123456/v1.19.32</id></entry>
    <entry><id>tag:github.com,2008:Repository/123456/v1.19.31</id></entry>
  </feed>`;
  const assets = '<a href="/MetaCubeX/mihomo/releases/download/Prerelease-Alpha/mihomo-linux-amd64-alpha-478af2a.gz">x</a><a href="/MetaCubeX/mihomo/releases/download/Prerelease-Alpha/mihomo-linux-arm64-alpha-478af2a.gz">x</a>';
  const fetcher = async url => {
    const value = String(url);
    if (value.includes('api.github.com')) return new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } });
    if (value.endsWith('releases.atom')) return new Response(atom, { status: 200 });
    if (value.includes('expanded_assets')) return new Response(assets, { status: 200 });
    return new Response('', { status: 404 });
  };
  const repository = new CoreRepository({ fetcher });
  const stable = await repository.catalog('metacubex-stable');
  assert.equal(stable.fallback, true);
  assert.equal(stable.entries.length, 6);
  assert.equal(stable.entries[0].verified, false);
  assert.equal(stable.entries[0].sha256, '');
  assert.equal(stable.entries[0].version, 'v1.19.33');
  const alpha = await repository.catalog('metacubex-test');
  assert.equal(alpha.fallback, true);
  assert.ok(alpha.entries.every(entry => entry.verified === false));
  assert.equal(alpha.entries.find(entry => entry.arch === 'x86_64').build, '478af2a');
});

test('下载校验 SHA256 与大小并清理失败文件', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clash-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from('core-bytes');
  const sha = createHash('sha256').update(payload).digest('hex');
  const entry = {
    id: 'metacubex-stable-v1.19.33-x86_64', channel: 'metacubex-stable', repository: 'MetaCubeX/mihomo', arch: 'x86_64',
    url: `${BASE}/mihomo-linux-amd64-v1.19.33.gz`, sha256: sha, size: payload.length, verified: true,
  };
  const repository = new CoreRepository({ fetcher: async () => new Response(payload, { status: 200 }) });
  const destination = path.join(directory, 'core.gz');
  await repository.download(entry, destination, { label: 'Core' });
  assert.deepEqual(await readFile(destination), payload);

  const wrong = path.join(directory, 'wrong.gz');
  await assert.rejects(() => repository.download({ ...entry, sha256: 'c'.repeat(64) }, wrong, { retryBaseMs: 1 }), /SHA256/);
  await assert.rejects(() => readFile(wrong), { code: 'ENOENT' });
  await assert.rejects(() => repository.download({ ...entry, url: 'https://evil.example/x.gz' }, wrong), /允许名单/);
});
