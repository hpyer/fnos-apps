import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, GitHubReleaseSource, NpmRegistrySource, UpdateChecker, selectUpdate } from '../src/check.mjs';

const repository = 'hpyer/fnos-apps';
const config = (tagPrefix, filePrefix = `${tagPrefix}-for-fnos`) => ({ repository, tagPrefix, filePrefix });
const release = (tagPrefix, version, arch = 'x86', extra = {}, filePrefix = `${tagPrefix}-for-fnos`) => ({
  tag_name: `${tagPrefix}/v${version}`, draft: false, prerelease: false,
  assets: [{ name: `${filePrefix}_v${version}_${arch}.fpk`, state: 'uploaded',
    browser_download_url: `https://github.com/${repository}/releases/download/${tagPrefix}/v${version}/${filePrefix}_v${version}_${arch}.fpk` }],
  ...extra,
});

test('selects only a newer release for this application and architecture', () => {
  const releases = [release('nginx', '9.0.0'), release('dsh', '1.2.0', 'arm'), release('dsh', '1.3.0'),
    release('dsh', '1.4.0', 'arm', { prerelease: true })];
  assert.equal(selectUpdate(releases, { ...config('dsh'), version: '1.1.2', arch: 'arm64' }).version, '1.2.0');
  assert.equal(selectUpdate(releases, { ...config('dsh'), version: '1.2.0', arch: 'arm64' }), null);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
});

test('caches successful checks and retries failures', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (calls === 1) throw Error('offline');
    return { ok: true, json: async () => [release('xterm', '1.2.0')] };
  };
  const checker = new UpdateChecker(new GitHubReleaseSource({ ...config('xterm'), version: '1.1.0', arch: 'x64', fetcher }), { cacheMs: 60_000, now: () => 1000 });
  await assert.rejects(checker.check(), /offline/);
  assert.equal((await checker.check()).update.version, '1.2.0');
  assert.equal((await checker.check()).update.version, '1.2.0');
  assert.equal(calls, 2);
  await checker.checkNow();
  assert.equal(calls, 3);
});

test('accepts a new app and its own release naming without changing the shared package', async () => {
  const app = { ...config('photos', 'album-manager'), version: '2.0.0', arch: 'x64' };
  const releases = [release('dsh', '99.0.0'), release('photos', '2.1.0', 'x86', {}, 'album-manager')];
  assert.equal(selectUpdate(releases, app).version, '2.1.0');
  const other = { ...app, repository: 'another/collection' };
  assert.equal(selectUpdate(releases, other), null);
  const urls = [];
  const checker = new UpdateChecker(new GitHubReleaseSource({ ...app, repository: 'another/collection', fetcher: async url => {
    urls.push(url);
    return { ok: true, json: async () => [] };
  } }));
  assert.equal((await checker.check()).update, null);
  assert.equal(urls[0], 'https://api.github.com/repos/another/collection/releases?per_page=100&page=1');
});

test('npm source resolves a package selector and validates integrity', async () => {
  const calls = [];
  const source = new NpmRegistrySource({ packageName: '@deepseek-ai/dsh', fetcher: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ name: '@deepseek-ai/dsh', version: '1.2.3', dist: { integrity: 'sha512-YWJjZA==' } }) };
  } });
  const checker = new UpdateChecker(source);
  assert.deepEqual(await checker.checkNow({ registry: 'https://registry.npmjs.org', selector: 'latest' }), { version: '1.2.3', integrity: 'sha512-YWJjZA==' });
  assert.equal(calls[0].url, 'https://registry.npmjs.org/%40deepseek-ai%2Fdsh/latest');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('custom source supports independent manual and automatic schedules', async () => {
  let calls = 0;
  const checker = new UpdateChecker({ check: async ({ channel }) => ({ channel, version: ++calls }) });
  assert.deepEqual(await checker.checkNow({ channel: 'stable' }), { channel: 'stable', version: 1 });
  const results = [];
  const first = checker.startAutoCheck({ intervalMs: 10, context: { channel: 'stable' }, onResult: result => results.push(result), immediate: false });
  const second = checker.startAutoCheck({ intervalMs: 25, context: { channel: 'mainline' }, onResult: result => results.push(result), immediate: false });
  try {
    await new Promise(resolve => setTimeout(resolve, 55));
    assert.ok(results.some(result => result.channel === 'stable'));
    assert.ok(results.some(result => result.channel === 'mainline'));
    assert.ok(results.filter(result => result.channel === 'stable').length > results.filter(result => result.channel === 'mainline').length);
  } finally { first.stop(); second.stop(); }
});
