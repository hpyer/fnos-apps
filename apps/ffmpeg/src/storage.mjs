import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function versionID(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value) || /[\r\n]/.test(value) || value.includes('..')) throw Error('版本标识无效');
  return value;
}
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function atomicJSON(file, value, mode = 0o600) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode, flag: 'wx' });
    await chmod(temp, mode); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
export async function currentVersion(root) {
  try {
    const target = await readlink(path.join(root, 'current'));
    if (!target.startsWith('versions/')) throw Error('当前版本指针无效');
    return versionID(target.slice(9));
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
export async function versionDirectory(root, id) {
  const directory = path.join(root, 'versions', versionID(id));
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('版本目录无效');
  const bin = await lstat(path.join(directory, 'bin'));
  if (!bin.isDirectory() || bin.isSymbolicLink()) throw Error('版本 bin 目录无效');
  return directory;
}
export async function metadata(root, id) {
  const directory = await versionDirectory(root, id);
  const result = JSON.parse(await readFile(path.join(directory, 'metadata.json'), 'utf8'));
  if (result.id !== id) throw Error('版本记录无效');
  return result;
}
export async function switchVersion(root, id) {
  const temp = path.join(root, `.current-${randomUUID()}`);
  try { await symlink(`versions/${versionID(id)}`, temp); await rename(temp, path.join(root, 'current')); }
  finally { await rm(temp, { force: true }); }
}
