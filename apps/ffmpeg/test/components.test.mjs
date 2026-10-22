import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ComponentRepository, componentPath, parseComponentIndex } from '../src/components.mjs';

const tag = '1789931697_9.0.2';
const link = arch => `<a href="/download/linux/${arch}/${tag}/ffmpeg.zip">FFmpeg</a>`;
const index = `<h2>Download Snapshot Build</h2>${link('amd64')}<h2>Download Release Build</h2>${link('amd64')}${link('arm64')}<h2>Info</h2>`;
const hash = createHash('sha256').update('abc').digest('hex');
test('独立组件按架构匹配稳定版，不采纳快照、其他域名和动态 latest 地址', () => {
  const [entry] = parseComponentIndex(index, 'arm64');
  assert.equal(entry.id, `martin-${tag}-arm64`);
  assert.equal(entry.components.ffmpeg.url, `https://ffmpeg.martin-riedl.de/download/linux/arm64/${tag}/ffmpeg.zip`);
  assert.equal(entry.components.ffprobe.url, componentPath(entry, 'ffprobe'));
  assert.deepEqual(parseComponentIndex(`<h2>Download Release Build</h2><a href="https://evil.example/download/linux/arm64/${tag}/ffmpeg.zip">bad</a>`, 'arm64'), []);
  assert.throws(() => parseComponentIndex('<html>blocked</html>', 'x64'), /没有稳定版/);
  assert.throws(() => componentPath({ arch: 'arm64', tag: 'latest' }, 'ffmpeg'), /标识无效/);
});
test('查询只请求 ffmpeg 校验和与体积，不下载 ffprobe，元数据保留精确构建路径', async () => {
  const calls = [];
  const repository = new ComponentRepository({ platform: 'linux', arch: 'x64', fetcher: async (url, options) => {
    calls.push([url, options.method]);
    if (url.endsWith('/')) return new Response(index);
    if (url.endsWith('.sha256')) return new Response(`${hash}  ffmpeg.zip\n`);
    return new Response(null, { headers: { 'content-length': '3' } });
  } });
  const [entry] = await repository.catalog();
  assert.equal(entry.size, 3); assert.equal(entry.components.ffmpeg.sha256, hash);
  assert.equal(calls.some(([url]) => url.includes('ffprobe')), false);
});
test('组件校验和与文件体积均强制校验，失败清理部分文件，保留同名已有文件', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-component-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [entry] = parseComponentIndex(index, 'x64'); entry.components.ffmpeg = { ...entry.components.ffmpeg, sha256: hash, size: 3 };
  const repository = new ComponentRepository({ arch: 'x64', fetcher: async () => new Response('abc') });
  const file = path.join(directory, 'component.zip');
  await repository.downloadComponent(entry, 'ffmpeg', file);
  assert.equal(await readFile(file, 'utf8'), 'abc');
  await assert.rejects(repository.downloadComponent(entry, 'ffmpeg', file), { code: 'EEXIST' });
  assert.equal(await readFile(file, 'utf8'), 'abc');
  repository.fetcher = async () => new Response('abd');
  await assert.rejects(repository.downloadComponent(entry, 'ffmpeg', path.join(directory, 'bad')), /SHA256/);
  await assert.rejects(stat(path.join(directory, 'bad')), { code: 'ENOENT' });
});
test('组件的重定向不能跨域或降级 HTTP，不接受另一个工具的校验清单', async () => {
  const [entry] = parseComponentIndex(index, 'arm64');
  for (const location of ['https://example.com/file', 'http://ffmpeg.martin-riedl.de/file']) {
    let requests = 0;
    const repository = new ComponentRepository({ fetcher: async () => { requests++; return new Response(null, { status: 302, headers: { location } }); } });
    await assert.rejects(repository.response(componentPath(entry, 'ffmpeg')), /允许名单/);
    assert.equal(requests, 1);
  }
  const repository = new ComponentRepository({ fetcher: async () => new Response(`${hash}  ffmpeg.zip`) });
  await assert.rejects(repository.asset(entry, 'ffprobe'), /SHA256 清单格式/);
});
