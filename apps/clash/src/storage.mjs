import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.mjs';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;

export function safeId(value, label = '标识') {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || value.includes('..')) fail(`${label}无效`);
  return value;
}

export function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString('hex');
}

export async function ensureDir(directory, mode = 0o700) {
  await mkdir(directory, { recursive: true, mode });
  await chmod(directory, mode);
  return directory;
}

export async function atomicWrite(file, data, mode = 0o600) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode, flag: 'wx' });
    await chmod(temporary, mode);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function atomicJSON(file, value, mode = 0o600) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function readJSON(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) fail(`状态文件损坏：${path.basename(file)}`);
    throw error;
  }
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function fileSize(file) {
  return (await stat(file)).size;
}

export async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function removePath(target) {
  await rm(target, { recursive: true, force: true });
}

export function isInside(parent, child) {
  const root = path.resolve(parent);
  const target = path.resolve(child);
  return target === root || target.startsWith(root + path.sep);
}
