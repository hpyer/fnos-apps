import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Build-time provisioning for the embedded dnsmasq runtime. The binary must be
// built on Debian 12 (glibc 2.36) to match fnOS; building on the Ubuntu 24.04
// runner produces GLIBC_2.38 symbols and fails on the NAS. Only the locked
// release assets are downloaded, and every artifact is checked against the
// recorded size, SHA-256 and target ELF machine.
const appRoot = fileURLToPath(new URL('../', import.meta.url));
export const lockFile = path.join(appRoot, 'core-versions.lock');
export const cacheRoot = path.join(appRoot, '.local', 'runtime');
const ALLOWED_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const MAX_BINARY = 8 * 1024 * 1024;
const MAX_LICENSE = 1024 * 1024;

export function architectureName(arch = process.arch) {
  if (arch === 'x64' || arch === 'x86_64') return 'x86_64';
  if (arch === 'arm64') return 'arm64';
  return null;
}

function validAsset(asset, machine) {
  return Boolean(asset) && typeof asset.url === 'string' && asset.url.startsWith('https://') &&
    /^[a-f0-9]{64}$/.test(asset.sha256 || '') && Number.isSafeInteger(asset.size) && asset.size > 0 &&
    asset.elfMachine === machine;
}

export async function loadLock(file = lockFile) {
  const lock = JSON.parse(await readFile(file, 'utf8'));
  if (lock?.schema !== 1 || typeof lock.version !== 'string' || !/^\d+\.\d+/.test(lock.version) ||
      typeof lock.source !== 'string' || !lock.source.startsWith('https://') ||
      !/^[a-f0-9]{64}$/.test(lock.sourceSha256 || '') ||
      typeof lock.license !== 'string' ||
      !lock.licenseFile || typeof lock.licenseFile.url !== 'string' || !lock.licenseFile.url.startsWith('https://') ||
      !/^[a-f0-9]{64}$/.test(lock.licenseFile.sha256 || '') || !Number.isSafeInteger(lock.licenseFile.size)) {
    throw Error('core-versions.lock 格式无效');
  }
  if (!validAsset(lock.assets?.x86_64, 62) || !validAsset(lock.assets?.arm64, 183)) {
    throw Error('core-versions.lock 缺少有效的 x86_64 或 arm64 运行时');
  }
  return lock;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function elfMachine(file) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 20 || header.toString('hex', 0, 4) !== '7f454c46' || header[4] !== 2 || header[5] !== 1) return 0;
    return header.readUInt16LE(18);
  } finally {
    await handle.close();
  }
}

async function verify(file, asset, label) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw Error(`${label} 不存在`);
  if (info.size !== asset.size) throw Error(`${label} 大小与锁文件不符（期望 ${asset.size}，实际 ${info.size}）`);
  if (await sha256(file) !== asset.sha256) throw Error(`${label} SHA-256 与锁文件不符`);
  if (asset.elfMachine && await elfMachine(file) !== asset.elfMachine) throw Error(`${label} 不是目标架构的 Linux 可执行文件`);
}

function checkUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw Error(`下载来源不在允许名单中：${parsed.hostname}`);
  }
  return value;
}

async function fetchBuffer(url, { fetchImpl, maxSize, retries = 3 }) {
  let current = checkUrl(url);
  for (let hop = 0; hop < 6; hop++) {
    const response = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5 * 60 * 1000),
      headers: { 'user-agent': 'fnos-dnsmasq-build', 'accept-encoding': 'identity' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw Error('下载重定向缺少目标地址');
      current = checkUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) {
      if (response.status >= 500 && retries > 0) return fetchBuffer(url, { fetchImpl, maxSize, retries: retries - 1 });
      throw Error(`下载失败：HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxSize) throw Error('下载内容超过大小限制');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxSize) throw Error('下载内容超过大小限制');
    return buffer;
  }
  throw Error('下载重定向次数过多');
}

async function download(url, target, options) {
  const buffer = await fetchBuffer(url, options);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.part`;
  await writeFile(temporary, buffer, { mode: 0o600 });
  await rename(temporary, target);
}

async function ensureLicense(lock, directory, { fetchImpl, log }) {
  const target = path.join(directory, 'COPYING');
  try {
    await verify(target, lock.licenseFile, 'dnsmasq 许可证');
    return target;
  } catch { /* missing or stale cache */ }
  await rm(target, { force: true });
  log(`下载 dnsmasq ${lock.version} 许可证`);
  await download(lock.licenseFile.url, target, { fetchImpl, maxSize: MAX_LICENSE });
  await verify(target, lock.licenseFile, 'dnsmasq 许可证');
  await chmod(target, 0o644);
  return target;
}

/**
 * Resolve a verified dnsmasq binary for the target architecture. An explicit
 * DNSMASQ_BINARY still has to match the locked SHA-256 and ELF machine, so an
 * accidental Ubuntu 24.04 build cannot be packaged for Debian 12 fnOS.
 */
export async function ensureEmbeddedDnsmasq({ arch = process.arch, binary = process.env.DNSMASQ_BINARY, lockPath = lockFile, cacheDir = cacheRoot, fetchImpl = fetch, log = message => console.log(message) } = {}) {
  const lock = await loadLock(lockPath);
  const archName = architectureName(arch);
  if (!archName) throw Error(`不支持的构建架构：${arch}；dnsmasq 只提供 x86_64 和 arm64 运行时`);
  const asset = lock.assets[archName];
  const directory = path.join(cacheDir, lock.version, archName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const license = await ensureLicense(lock, path.join(cacheDir, lock.version), { fetchImpl, log });
  const target = path.join(directory, 'dnsmasq');

  if (binary) {
    try {
      await verify(binary, asset, `DNSMASQ_BINARY（${archName}）`);
    } catch (error) {
      throw Error(`${error.message}；如需自定义构建，请更新 core-versions.lock 并重新发布运行时`);
    }
    return { binary, license, version: lock.version, arch: archName, sha256: asset.sha256 };
  }

  try {
    await verify(target, asset, `dnsmasq ${lock.version} ${archName}`);
  } catch {
    await rm(target, { force: true });
    log(`下载 dnsmasq ${lock.version} ${archName}：${asset.url}`);
    await download(asset.url, target, { fetchImpl, maxSize: MAX_BINARY });
    try {
      await verify(target, asset, `dnsmasq ${lock.version} ${archName}`);
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
  }
  await chmod(target, 0o755);
  return { binary: target, license, version: lock.version, arch: archName, sha256: asset.sha256 };
}
