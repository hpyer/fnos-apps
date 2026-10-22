import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FFmpegManager } from '../src/manager.mjs';
import { catalogAction } from '../src/catalog-action.mjs';
import { atomicJSON, currentVersion, hashFile, metadata } from '../src/storage.mjs';

const build = id => ({ id, name: `${id}.tar.xz`, arch: 'arm64', build: 'n9.0.2', tag: id, size: 3 });
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-manager-'));
  const repository = { catalog: async () => [build('one'), build('two')], download: async (entry, file, options) => { await writeFile(file, 'abc'); options.progress(3, 3); } };
  const run = async (binary, args) => {
    if (binary === '/usr/bin/flock' && args[0] === '--no-fork') return catalogAction(root, args[6], args[7], { candidate: args[8], execute: () => ({ status: 0 }) });
    if (binary.endsWith('/ffprobe') && args.includes('-show_entries')) return '{"streams":[{"codec_name":"pcm_s16le"}]}';
    if (['ffmpeg', 'ffprobe'].includes(path.basename(binary)) && args.includes('-version')) return `${path.basename(binary)} version n9.0.2 Copyright`;
    return '';
  };
  const extract = async (archive, directory, prefix, { tools = ['ffmpeg', 'ffprobe'] } = {}) => {
    await mkdir(path.join(directory, 'bin'), { recursive: true });
    const elf = Buffer.alloc(64); elf.write('\x7fELF'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(183, 18);
    for (const tool of tools) await writeFile(path.join(directory, 'bin', tool), elf);
    await writeFile(path.join(directory, 'LICENSE.txt'), 'GPL');
  };
  const manager = new FFmpegManager(root, { platform: 'linux', arch: 'arm64', repository, run, extract, ...overrides });
  await manager.init(); await manager.check();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return manager;
}
async function operation(manager, action, id) { manager.start(action, id); await manager.task; return manager.job; }
test('首次下载不自动启用；切换与回滚保持当前指针与上一版本', async t => {
  const manager = await fixture(t);
  assert.equal((await operation(manager, 'install', 'one')).state, 'success');
  assert.equal(await currentVersion(manager.root), '');
  assert.equal((await manager.status()).installed[0].version, 'n9.0.2');
  assert.equal((await operation(manager, 'activate', 'one')).state, 'success');
  await operation(manager, 'install', 'two');
  assert.equal(await currentVersion(manager.root), 'one');
  await operation(manager, 'activate', 'two');
  assert.equal(await currentVersion(manager.root), 'two');
  assert.equal(await manager.previous(), 'one');
  await operation(manager, 'rollback');
  assert.equal(await currentVersion(manager.root), 'one');
  assert.equal(await manager.previous(), 'two');
  assert.equal((await operation(manager, 'remove', 'one')).state, 'error');
  assert.match(manager.job.message, /不能删除当前/);
});
test('下载、架构校验、自检及启用失败均保留当前版本并清理暂存', async t => {
  const manager = await fixture(t);
  await operation(manager, 'install', 'one'); await operation(manager, 'activate', 'one');
  const extract = manager.extract, run = manager.run;
  manager.extract = async (...args) => { await extract(...args); await writeFile(path.join(args[1], 'bin/ffmpeg'), 'wrong binary'); };
  assert.equal((await operation(manager, 'install', 'two')).state, 'error');
  assert.equal(await currentVersion(manager.root), 'one');
  assert.deepEqual(await readdir(path.join(manager.root, 'staging')), []);
  manager.extract = extract;
  manager.run = async (binary, args) => args.includes('anullsrc=r=8000:cl=mono') ? Promise.reject(Error('self test failed')) : run(binary, args);
  assert.equal((await operation(manager, 'install', 'two')).state, 'error');
  assert.equal(await currentVersion(manager.root), 'one');
  manager.run = run; await operation(manager, 'install', 'two');
  await chmod(path.join(manager.root, 'versions/two/bin/ffmpeg'), 0o755);
  await writeFile(path.join(manager.root, 'versions/two/bin/ffmpeg'), 'tampered');
  assert.equal((await operation(manager, 'activate', 'two')).state, 'error');
  assert.match(manager.job.message, /已改动/);
  assert.equal(await currentVersion(manager.root), 'one');
});
test('只接受服务器检查过的版本，禁止并发安装，关闭会中止下载', async t => {
  const manager = await fixture(t);
  assert.throws(() => manager.start('install', 'not-checked'), /先检查更新/);
  assert.throws(() => manager.start('activate', '../outside'), /版本标识/);
  manager.repository.download = async (entry, file, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
  const started = manager.start('install', 'one');
  assert.equal(started.job.state, 'running');
  assert.throws(() => manager.start('install', 'two'), /已有版本操作/);
  // Wait until the mocked download has subscribed to abort.
  while (!manager.job.message.includes('下载')) await new Promise(resolve => setImmediate(resolve));
  await manager.close();
  assert.equal(manager.job.state, 'error');
  assert.deepEqual(await readdir(path.join(manager.root, 'staging')), []);
});
test('默认 umask 077 下命令目录可遍历、可执行，状态文件保持私有', async t => {
  const previous = process.umask(0o077);
  try {
    const manager = await fixture(t);
    await operation(manager, 'install', 'one'); await operation(manager, 'activate', 'one');
    await operation(manager, 'install', 'two'); await operation(manager, 'activate', 'two');
    for (const file of ['', 'versions', 'versions/one', 'versions/one/bin']) assert.equal((await lstat(path.join(manager.root, file))).mode & 0o777, 0o755);
    for (const file of ['catalog.lock', 'versions/one/.use.lock', 'versions/one/metadata.json']) assert.equal((await lstat(path.join(manager.root, file))).mode & 0o777, 0o644);
    assert.equal((await lstat(path.join(manager.root, 'versions/one/bin/ffmpeg'))).mode & 0o777, 0o555);
    assert.equal((await lstat(path.join(manager.root, 'previous.json'))).mode & 0o777, 0o600);
  } finally { process.umask(previous); }
});
test('重启清理未完成下载，保留已安装版本与当前指针', async t => {
  const manager = await fixture(t);
  await operation(manager, 'install', 'one'); await operation(manager, 'activate', 'one');
  await writeFile(path.join(manager.root, 'operation.json'), '{}');
  await mkdir(path.join(manager.root, 'staging/interrupted')); await writeFile(path.join(manager.root, 'staging/interrupted/partial'), 'partial');
  await manager.init();
  assert.match(manager.job.message, /被中断/);
  assert.equal(await currentVersion(manager.root), 'one');
  assert.deepEqual(await readdir(path.join(manager.root, 'staging')), []);
});
test('拒绝执行被改成链接的版本文件', async t => {
  const manager = await fixture(t);
  await operation(manager, 'install', 'one');
  const binary = path.join(manager.root, 'versions/one/bin/ffmpeg');
  await rm(binary); await symlink('/bin/sh', binary);
  assert.equal((await operation(manager, 'activate', 'one')).state, 'error');
  assert.equal(await currentVersion(manager.root), '');
});
test('x86_64 ELF 校验不接受 ARM64 文件', async t => {
  const manager = await fixture(t);
  await operation(manager, 'install', 'one');
  manager.arch = 'x64';
  const directory = path.join(manager.root, 'versions/one');
  await assert.rejects(manager.validate(directory), /设备架构不匹配/);
  for (const tool of ['ffmpeg']) {
    const file = path.join(directory, 'bin', tool), bytes = await readFile(file);
    bytes.writeUInt16LE(62, 18); await chmod(file, 0o755); await writeFile(file, bytes);
  }
  assert.equal((await manager.validate(directory)).version, 'n9.0.2');
});
test('一分钟内重复检查复用成功结果，不反复消耗匿名 API 配额', async t => {
  const manager = await fixture(t);
  let calls = 0;
  manager.checker.cached.clear();
  manager.repository.catalog = async () => { calls++; return [build('one')]; };
  await manager.check(); await manager.check();
  assert.equal(calls, 1);
});

async function componentFixture(t) {
  const downloads = [];
  const entry = id => ({ ...build(id), format: 'components', components: { ffmpeg: { url: id + '/ffmpeg.zip' }, ffprobe: { url: id + '/ffprobe.zip' } } });
  const repository = {
    catalog: async () => ['one', 'two', 'three'].map(entry),
    downloadComponent: async (entry, tool, destination, { progress }) => {
      downloads.push([entry.id, tool]); await writeFile(destination, tool); progress(3, 3);
      return { url: entry.id + '/' + tool + '.zip', sha256: 'a'.repeat(64), size: 3 };
    }
  };
  const extractZip = async (archive, directory, tool) => {
    await mkdir(path.join(directory, 'bin'), { recursive: true });
    const elf = Buffer.alloc(64); elf.write('\x7fELF'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(183, 18);
    await writeFile(path.join(directory, 'bin', tool), elf);
  };
  const manager = await fixture(t, { repository, extractZip });
  return { manager, downloads };
}
test('默认仅下载 ffmpeg；勾选先补当前版本，后续新版本两组件同步', async t => {
  const { manager, downloads } = await componentFixture(t);
  await operation(manager, 'install', 'one'); await operation(manager, 'activate', 'one');
  assert.deepEqual(downloads, [['one', 'ffmpeg']]);
  assert.equal((await manager.status()).ffprobeEnabled, false);
  assert.equal((await manager.status()).installed[0].hasFFprobe, false);
  const file = path.join(manager.root, 'versions/one/bin/ffmpeg'), hash = await hashFile(file), inode = (await lstat(file)).ino;
  assert.equal((await operation(manager, 'probe', true)).state, 'success');
  assert.equal(manager.ffprobeEnabled, true);
  assert.deepEqual(downloads.at(-1), ['one', 'ffprobe']);
  assert.equal((await manager.status()).installed[0].hasFFprobe, true);
  assert.equal(await currentVersion(manager.root), 'one');
  assert.equal(await hashFile(file), hash); assert.equal((await lstat(file)).ino, inode);
  await operation(manager, 'install', 'two');
  assert.deepEqual(downloads.slice(-2), [['two', 'ffmpeg'], ['two', 'ffprobe']]);
  assert.equal(await currentVersion(manager.root), 'one');
  const count = downloads.length;
  await operation(manager, 'probe', true); assert.equal(downloads.length, count);
  await manager.init(); assert.equal(manager.ffprobeEnabled, true);
});
test('没有当前版本可直接保存选项；取消只停止后续同步，已有组件保留', async t => {
  const { manager, downloads } = await componentFixture(t);
  assert.equal((await operation(manager, 'probe', true)).state, 'success');
  assert.deepEqual(downloads, []);
  await operation(manager, 'install', 'one'); await operation(manager, 'activate', 'one');
  await operation(manager, 'probe', false);
  assert.equal(manager.ffprobeEnabled, false); assert.equal(await manager.hasProbe('one'), true);
  await operation(manager, 'install', 'two');
  assert.deepEqual(downloads.at(-1), ['two', 'ffmpeg']); assert.equal(await manager.hasProbe('two'), false);
  await manager.init(); assert.equal(manager.ffprobeEnabled, false);
  assert.throws(() => manager.start('probe', 'true'), /布尔值/);
});
test('补装下载失败或版本不匹配不保存勾选状态，不修改当前二进制和元数据', async t => {
  const { manager } = await componentFixture(t);
  await operation(manager, 'install', 'one'); await operation(manager, 'activate', 'one');
  const original = await metadata(manager.root, 'one'), download = manager.repository.downloadComponent, run = manager.run;
  manager.repository.downloadComponent = async () => { throw Error('download failed'); };
  assert.equal((await operation(manager, 'probe', true)).state, 'error');
  assert.equal(manager.ffprobeEnabled, false); assert.equal(await manager.hasProbe('one'), false);
  assert.deepEqual(await metadata(manager.root, 'one'), original);
  manager.repository.downloadComponent = download;
  manager.run = async (binary, args, options) => binary.endsWith('/ffprobe') && args.includes('-version') ? 'ffprobe version n8.1.0' : run(binary, args, options);
  assert.equal((await operation(manager, 'probe', true)).state, 'error');
  assert.match(manager.job.message, /版本不一致/);
  assert.equal(manager.ffprobeEnabled, false); assert.equal(await manager.hasProbe('one'), false);
  assert.equal(await currentVersion(manager.root), 'one');
  assert.deepEqual(await metadata(manager.root, 'one'), original);
  assert.deepEqual(await readdir(path.join(manager.root, 'staging')), []);
});
test('启用和回滚到缺少 ffprobe 的历史版本时先补齐目标构建', async t => {
  const { manager, downloads } = await componentFixture(t);
  await operation(manager, 'install', 'one'); await operation(manager, 'activate', 'one');
  await operation(manager, 'install', 'two');
  await operation(manager, 'probe', true); await operation(manager, 'activate', 'two');
  assert.equal(await manager.hasProbe('two'), true); assert.deepEqual(downloads.at(-1), ['two', 'ffprobe']);
  await operation(manager, 'probe', false); await operation(manager, 'install', 'three');
  await operation(manager, 'activate', 'three');
  await operation(manager, 'activate', 'two');
  await operation(manager, 'probe', true); await operation(manager, 'rollback');
  assert.equal(await currentVersion(manager.root), 'three'); assert.equal(await manager.hasProbe('three'), true);
  assert.deepEqual(downloads.at(-1), ['three', 'ffprobe']);
});
test('补装中停止服务会清理暂存，保留当前 ffmpeg 和原同步选项', async t => {
  const { manager } = await componentFixture(t);
  await operation(manager, 'install', 'one'); await operation(manager, 'activate', 'one');
  const info = await metadata(manager.root, 'one'); let downloading = false;
  manager.repository.downloadComponent = async (entry, tool, file, { signal }) => new Promise((resolve, reject) => {
    downloading = true; signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  });
  manager.start('probe', true);
  while (!downloading) await new Promise(resolve => setImmediate(resolve));
  await manager.close();
  assert.equal(manager.job.state, 'error'); assert.equal(manager.ffprobeEnabled, false);
  assert.equal(await currentVersion(manager.root), 'one'); assert.deepEqual(await metadata(manager.root, 'one'), info);
  assert.deepEqual(await readdir(path.join(manager.root, 'staging')), []);
});
test('历史版本补装失败时拒绝切换，仍使用当前完整版本', async t => {
  const { manager } = await componentFixture(t);
  await operation(manager, 'install', 'one'); await operation(manager, 'activate', 'one');
  await operation(manager, 'install', 'two'); await operation(manager, 'probe', true);
  manager.repository.downloadComponent = async () => { throw Error('old build unavailable'); };
  assert.equal((await operation(manager, 'activate', 'two')).state, 'error');
  assert.equal(await currentVersion(manager.root), 'one'); assert.equal(await manager.hasProbe('one'), true);
});
test('旧 BtbN 已含 ffprobe 的版本继续可用，勾选不重复下载', async t => {
  const manager = await fixture(t);
  await operation(manager, 'probe', true); await operation(manager, 'install', 'one'); await operation(manager, 'activate', 'one');
  await operation(manager, 'probe', false);
  manager.repository.download = async () => { throw Error('must not download'); };
  assert.equal((await operation(manager, 'probe', true)).state, 'success');
});
test('补装在二进制提交后中断，可从受校验的日志恢复元数据', async t => {
  const { manager } = await componentFixture(t);
  await operation(manager, 'install', 'one');
  const directory = path.join(manager.root, 'versions/one'), file = path.join(directory, 'bin/ffprobe');
  await writeFile(file, await readFile(path.join(directory, 'bin/ffmpeg')));
  const info = await metadata(manager.root, 'one');
  await atomicJSON(path.join(directory, '.probe-pending.json'), { ...info, hashes: { ...info.hashes, ffprobe: await hashFile(file) } });
  await manager.init();
  assert.equal(await manager.hasProbe('one'), true);
  await assert.rejects(lstat(path.join(directory, '.probe-pending.json')), { code: 'ENOENT' });
});
