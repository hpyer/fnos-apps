import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lstat, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicJSON, currentVersion, hashFile, metadata, switchVersion, versionDirectory, versionID } from './storage.mjs';

// Called only by the manager under catalog.lock, and for delete under .use.lock as well.
export async function catalogAction(root, action, id, { flock = '/usr/bin/flock', execute = spawnSync, candidate } = {}) {
  versionID(id);
  const directory = await versionDirectory(root, id);
  if (action === 'activate') {
    await metadata(root, id);
    const current = await currentVersion(root);
    if (current !== id) {
      // Save rollback target before changing the authoritative current symlink.
      if (current) {
        await atomicJSON(path.join(root, 'previous.json'), { id: current });
      }
      await switchVersion(root, id);
    }
  } else if (action === 'probe') {
    const staging = await realpath(path.join(root, 'staging'));
    if (!candidate || !(await realpath(candidate)).startsWith(staging + path.sep)) throw Error('组件暂存目录无效');
    const next = JSON.parse(await readFile(path.join(candidate, 'metadata.json'), 'utf8'));
    await commitProbe(directory, candidate, id, next);
  } else if (action === 'recover-probe') {
    const pending = path.join(directory, '.probe-pending.json');
    const next = JSON.parse(await readFile(pending, 'utf8'));
    try {
      const probe = path.join(directory, 'bin/ffprobe'), details = await lstat(probe);
      const current = await metadata(root, id);
      if (next.id !== id || !details.isFile() || details.isSymbolicLink() || next.hashes?.ffmpeg !== current.hashes?.ffmpeg ||
          await hashFile(path.join(directory, 'bin/ffmpeg')) !== next.hashes?.ffmpeg ||
          await hashFile(probe) !== next.hashes?.ffprobe) throw Error('组件恢复校验失败');
      await atomicJSON(path.join(directory, 'metadata.json'), next, 0o644);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(pending, { force: true });
  } else if (action === 'remove') {
    if (await currentVersion(root) === id) throw Error('不能删除当前启用的版本');
    const result = execute(flock, ['-n', '-E', '75', '-x', path.join(directory, '.use.lock'), process.execPath, fileURLToPath(import.meta.url), root, 'delete', id], { encoding: 'utf8', timeout: 30000 });
    if (result.error) throw result.error;
    if (result.status === 75) throw Error('该版本仍有命令在运行，结束后再删除');
    if (result.status !== 0) throw Error(result.stderr?.trim() || '删除版本失败');
  } else if (action === 'delete') {
    if (await currentVersion(root) === id) throw Error('不能删除当前启用的版本');
    await rm(directory, { recursive: true });
  } else { throw Error('未知版本操作'); }
}
async function commitProbe(directory, candidate, id, next) {
  const source = path.join(candidate, 'bin/ffprobe'), target = path.join(directory, 'bin/ffprobe');
  const details = await lstat(source);
  if (next.id !== id || !details.isFile() || details.isSymbolicLink() || await hashFile(source) !== next.hashes?.ffprobe) throw Error('补装组件校验失败');
  const current = JSON.parse(await readFile(path.join(directory, 'metadata.json'), 'utf8'));
  if (current.hashes?.ffmpeg !== next.hashes?.ffmpeg || await hashFile(path.join(directory, 'bin/ffmpeg')) !== next.hashes?.ffmpeg) throw Error('ffmpeg 记录已变化，补装未提交');
  try { await lstat(target); throw Error('ffprobe 已存在，不能覆盖'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = path.join(directory, '.probe-pending.json');
  await atomicJSON(pending, next);
  let moved = false;
  try {
    await rename(source, target); moved = true;
    await atomicJSON(path.join(directory, 'metadata.json'), next, 0o644);
  } catch (error) {
    if (moved) await rename(target, source);
    await rm(pending, { force: true }); throw error;
  }
  // After metadata commits, cleanup failure must not roll the executable back.
  // A surviving journal is safe to replay on the next startup.
  await rm(pending, { force: true }).catch(() => {});
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root, action, id, candidate] = process.argv.slice(2);
  try { await catalogAction(root, action, id, { candidate }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
