import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FFmpegRepository, MAX_DOWNLOAD, parseChecksums, parseFeed, parseRelease, targetArchitecture } from '../src/repository.mjs';

const tag = 'autobuild-2026-10-19-13-06';
function release(arch = 'linux64', branch = '9.0', extra = {}) {
  const name = `ffmpeg-n${branch}.2-28-g669f5ab083-${arch}-gpl-${branch}.tar.xz`;
  return { tag_name: tag, published_at: '2026-10-19T13:08:02Z', assets: [{ name, size: 3, digest: `sha256:${'a'.repeat(64)}`,
    browser_download_url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${tag}/${name}`, ...extra }] };
}
test('分别匹配 x86_64 / ARM64 的非 shared GPL 发布分支资产', () => {
  assert.equal(parseRelease(release(), 'x64')[0].build, 'n9.0.2-28-g669f5ab083');
  assert.equal(parseRelease(release('linuxarm64'), 'arm64')[0].arch, 'arm64');
  assert.equal(parseRelease(release(), 'arm64').length, 0);
  assert.equal(parseRelease(release('linux64-gpl-shared'), 'x64').length, 0);
  assert.equal(parseRelease({ ...release(), tag_name: 'latest' }, 'x64').length, 0);
  assert.equal(parseRelease(release('linux64', '9.0', { digest: null }), 'x64').length, 0);
  assert.equal(parseRelease(release('linux64', '9.0', { size: MAX_DOWNLOAD + 1 }), 'x64').length, 0);
  assert.equal(parseRelease(release('linux64', '9.0', { browser_download_url: 'https://example.com/file' }), 'x64').length, 0);
  assert.throws(() => targetArchitecture('darwin', 'arm64'), /仅支持 Linux/);
  assert.throws(() => targetArchitecture('linux', 'arm'), /仅支持 Linux/);
});
test('每个发布分支只展示最新的固定标签构建，按主次版本排序', async () => {
  const old = release(); old.tag_name = 'autobuild-2026-10-18-13-06';
  old.assets[0].browser_download_url = old.assets[0].browser_download_url.replace(tag, old.tag_name);
  const repository = new FFmpegRepository({ platform: 'linux', arch: 'x64', fetcher: async () => Response.json([release('linux64', '8.1'), old, release()]) });
  const entries = await repository.catalog();
  assert.deepEqual(entries.map(item => item.branch), ['9.0', '8.1']);
  assert.equal(entries[0].tag, tag);
});
test('下载校验 SHA256 和大小；失败时清理部分文件', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = parseRelease(release('linux64', '9.0', { digest: `sha256:${createHash('sha256').update('abc').digest('hex')}` }), 'x64')[0];
  const repository = new FFmpegRepository({ platform: 'linux', arch: 'x64', fetcher: async () => new Response('abc') });
  const file = path.join(directory, 'file'); const progress = [];
  await repository.download(entry, file, { progress: (...values) => progress.push(values) });
  assert.equal(await readFile(file, 'utf8'), 'abc');
  assert.deepEqual(progress.at(-1), [3, 3]);
  for (const data of ['abd', 'ab', 'abcd']) {
    repository.fetcher = async () => new Response(data);
    const target = path.join(directory, data);
    await assert.rejects(repository.download(entry, target), /校验失败|大小不符/);
    await assert.rejects(stat(target), { code: 'ENOENT' });
  }
});
test('每次重定向均检查来源，不向任意域名或 HTTP 地址下载', async () => {
  for (const target of ['http://github.com/file', 'https://example.com/file', 'https://user@release-assets.githubusercontent.com/file']) {
    let requests = 0;
    const repository = new FFmpegRepository({ fetcher: async () => { requests++; return new Response(null, { status: 302, headers: { location: target } }); } });
    await assert.rejects(repository.response(`https://github.com/BtbN/FFmpeg-Builds/releases/download/${tag}/file`), /允许名单/);
    assert.equal(requests, 1);
  }
});
test('允许 GitHub 资产 CDN 重定向，普通 403 不冒充 API 限流', async () => {
  const urls = [];
  const repository = new FFmpegRepository({ platform: 'linux', arch: 'x64', fetcher: async url => {
    urls.push(url);
    return urls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file' } }) : new Response('abc');
  } });
  assert.equal(await (await repository.response(`https://github.com/BtbN/FFmpeg-Builds/releases/download/${tag}/file`)).text(), 'abc');
  repository.fetcher = async () => new Response(null, { status: 403 });
  await assert.rejects(repository.response('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases', { api: true }), error => {
    assert.match(error.message, /版本查询 API.*HTTP 403/);
    assert.doesNotMatch(error.message, /已限流/); return true;
  });
});

const feed = entries => `<feed xmlns="http://www.w3.org/2005/Atom">${entries.map(({ tag, publishedAt = '2026-10-19T13:08:02Z' }) => `<entry><id>tag:github.com,2008:Repository/292087234/${tag}</id><updated>${publishedAt}</updated></entry>`).join('')}</feed>`;
const manifest = (...releases) => releases.flatMap(release => release.assets.map(asset => `${asset.digest.slice(7)}  ${asset.name}`)).join('\n');
test('Atom 只接受固定日期标签，SHA256 清单继续过滤架构和构建类型', () => {
  const releases = parseFeed(feed([{ tag: 'latest' }, { tag: 'autobuild-2026-10-18-13-06' }, { tag }, { tag: 'autobuild-2026-10-20-13-06', publishedAt: 'invalid' }]));
  assert.deepEqual(releases.map(item => item.tag), [tag, 'autobuild-2026-10-18-13-06']);
  const source = manifest(release(), release('linuxarm64'), release('linux64-gpl-shared'));
  const entries = parseChecksums(source, releases[0], 'arm64');
  assert.equal(entries.length, 1); assert.equal(entries[0].arch, 'arm64'); assert.equal(entries[0].size, null);
  assert.equal(parseChecksums('bad checksum\n' + 'a'.repeat(64) + '  ../escape.tar.xz', releases[0], 'x64').length, 0);
  assert.throws(() => parseChecksums(manifest(release(), release()), releases[0], 'x64'), /重复文件/);
  assert.throws(() => parseFeed('<html>blocked</html>'), /格式无效/);
  assert.throws(() => parseChecksums(source, { tag: 'latest' }, 'arm64'), /固定构建标签/);
});
test('API 限流时自动使用发行订阅和校验文件，恢复前不重复请求 API', async () => {
  const urls = []; let clock = 1000;
  const repository = new FFmpegRepository({ platform: 'linux', arch: 'x64', now: () => clock, fetcher: async url => {
    urls.push(url);
    if (url.startsWith('https://api.github.com/')) return new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3600' } });
    if (url.endsWith('/releases.atom')) return new Response(feed([{ tag }]));
    if (url.endsWith('/checksums.sha256')) return new Response(manifest(release()));
    throw Error('unexpected URL');
  } });
  const entries = await repository.catalog();
  assert.equal(entries[0].id, `${tag}-9.0-x64`); assert.equal(entries[0].sha256, 'a'.repeat(64));
  await repository.catalog();
  assert.equal(urls.filter(url => url.startsWith('https://api.github.com/')).length, 1);
  clock = 3600001; await repository.catalog();
  assert.equal(urls.filter(url => url.startsWith('https://api.github.com/')).length, 2);
});
test('API 网络不可达也可以回退；API 正常时不请求备用来源', async () => {
  const urls = [];
  const repository = new FFmpegRepository({ platform: 'linux', arch: 'arm64', fetcher: async url => {
    urls.push(url);
    if (url.startsWith('https://api.github.com/')) throw new TypeError('fetch failed');
    if (url.endsWith('/releases.atom')) return new Response(feed([{ tag }]));
    return new Response(manifest(release('linuxarm64')));
  } });
  assert.equal((await repository.catalog())[0].arch, 'arm64');
  repository.apiRetryAt = 0; urls.length = 0;
  repository.fetcher = async url => { urls.push(url); return Response.json([release('linuxarm64')]); };
  assert.equal((await repository.catalog())[0].size, 3); assert.equal(urls.length, 1);
});
test('文件服务器 403 区分于 API 限流，错误不包含 CDN 签名参数', async () => {
  let count = 0;
  const repository = new FFmpegRepository({ fetcher: async () => ++count === 1 ?
    new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file?sig=do-not-show' } }) : new Response(null, { status: 403 }) });
  await assert.rejects(repository.response(`https://github.com/BtbN/FFmpeg-Builds/releases/download/${tag}/file`), error => {
    assert.match(error.message, /文件下载.*release-assets\.githubusercontent\.com.*HTTP 403/);
    assert.doesNotMatch(error.message, /已限流|sig=|do-not-show/); return true;
  });
});
test('Retry-After 会被遵守，备用来源失败时保留两个阶段的可读原因', async () => {
  let calls = 0;
  const repository = new FFmpegRepository({ platform: 'linux', arch: 'x64', now: () => 1000, fetcher: async () => ++calls === 1 ?
    new Response(null, { status: 429, headers: { 'retry-after': '120' } }) : new Response(null, { status: 403 }) });
  await assert.rejects(repository.catalog(), /版本查询 API 已限流.*备用来源.*发行订阅.*HTTP 403/);
  assert.equal(repository.apiRetryAt, 121000);
});
test('校验清单回退下载允许未知大小，仍强制校验 SHA256 和最大体积', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-manifest-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = parseChecksums(manifest(release('linux64', '9.0', { digest: `sha256:${createHash('sha256').update('abc').digest('hex')}` })), { tag, publishedAt: '2026-10-19T13:08:02Z' }, 'x64')[0];
  const repository = new FFmpegRepository({ arch: 'x64', fetcher: async () => new Response('abc', { headers: { 'content-length': '3' } }) });
  const progress = [];
  await repository.download(entry, path.join(directory, 'known'), { progress: (...values) => progress.push(values) });
  assert.deepEqual(progress.at(-1), [3, 3]);
  repository.fetcher = async () => new Response('abc');
  await repository.download(entry, path.join(directory, 'unknown'));
  assert.equal(await readFile(path.join(directory, 'unknown'), 'utf8'), 'abc');
  repository.fetcher = async () => new Response('abd');
  await assert.rejects(repository.download(entry, path.join(directory, 'bad')), /SHA256/);
  repository.fetcher = async () => new Response('abc', { headers: { 'content-length': String(MAX_DOWNLOAD + 1) } });
  await assert.rejects(repository.download(entry, path.join(directory, 'large')), /超过限制/);
});
