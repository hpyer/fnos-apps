import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Build-time provisioning for the embedded mihomo cores. Only locked versions
// from core-versions.lock are fetched; every download is checked against the
// recorded SHA256, size, gzip integrity and target ELF architecture.
const appRoot = fileURLToPath(new URL('../', import.meta.url));
export const cacheDir = path.join(appRoot, '.local', 'cores');
export const lockFile = path.join(appRoot, 'core-versions.lock');
const ALLOWED_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com']);
const MAX_COMPRESSED = 96 * 1024 * 1024;
const MAX_EXPANDED = 256 * 1024 * 1024;

export function architectureName(arch = process.arch) {
  if (arch === 'x64' || arch === 'x86_64') return 'x86_64';
  if (arch === 'arm64') return 'arm64';
  return null;
}

export async function loadLock(file = lockFile) {
  const lock = JSON.parse(await readFile(file, 'utf8'));
  if (lock?.schema !== 1 || !/^v\d+\.\d+\.\d+$/.test(lock.version || '') || typeof lock.source !== 'string') throw Error('core-versions.lock 格式无效');
  for (const arch of ['x86_64', 'arm64']) {
    const asset = lock.assets?.[arch];
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256 || '') || !Number.isSafeInteger(asset.size) ||
        !asset.url?.startsWith('https://github.com/MetaCubeX/mihomo/releases/download/')) throw Error(`core-versions.lock 中 ${arch} 资产无效`);
  }
  if (!lock.licenseFile || !/^[a-f0-9]{64}$/.test(lock.licenseFile.sha256 || '')) throw Error('core-versions.lock 缺少许可证校验信息');
  return lock;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function download(url, destination, { retries = 3 } = {}) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const temporary = `${destination}.part`;
    try {
      let current = url;
      for (let hop = 0; hop < 6; hop++) {
        const parsed = new URL(current);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !ALLOWED_HOSTS.has(parsed.hostname)) throw Error(`下载来源不在允许名单中：${parsed.hostname}`);
        const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(5 * 60 * 1000), headers: { 'user-agent': 'fnos-clash-build', 'accept-encoding': 'identity' } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw Error('下载重定向缺少目标地址');
          current = new URL(location, current).href;
          continue;
        }
        if (!response.ok || !response.body) throw Error(`下载失败：HTTP ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }));
        await rename(temporary, destination);
        return;
      }
      throw Error('下载重定向次数过多');
    } catch (error) {
      lastError = error;
      await rm(temporary, { force: true });
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw Error(`下载内置 Core 失败：${lastError?.message || '未知错误'}`);
}

// Verify gzip integrity and the target ELF machine without executing anything.
async function verifyCoreGzip(file, expectedMachine, label) {
  let header = Buffer.alloc(0), expanded = 0;
  const gunzip = createGunzip({ maxOutputLength: MAX_EXPANDED });
  for await (const chunk of createReadStream(file).pipe(gunzip)) {
    expanded += chunk.length;
    if (expanded > MAX_EXPANDED) throw Error(`${label} 解压后超过大小限制`);
    if (header.length < 64) header = Buffer.concat([header, chunk.subarray(0, 64 - header.length)]);
  }
  if (header.length < 20 || header.toString('hex', 0, 4) !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== expectedMachine) {
    throw Error(`${label} 不是目标架构的 Linux 可执行文件`);
  }
  return expanded;
}

async function ensureAsset(asset, version, arch, log) {
  const directory = path.join(cacheDir, version);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${arch}.mihomo.gz`);
  if (await exists(target)) {
    const info = await stat(target);
    if (info.size === asset.size && await sha256(target) === asset.sha256) {
      await verifyCoreGzip(target, asset.elfMachine, `${arch} Core`);
      return target;
    }
    log(`内置 ${arch} Core 缓存校验失败，重新下载`);
  }
  log(`下载 mihomo ${version} ${arch}：${asset.name}`);
  await download(asset.url, target);
  const info = await stat(target);
  if (info.size !== asset.size || await sha256(target) !== asset.sha256) {
    await rm(target, { force: true });
    throw Error(`内置 ${arch} Core 的 SHA256 或大小与锁文件不符`);
  }
  await verifyCoreGzip(target, asset.elfMachine, `${arch} Core`);
  await chmod(target, 0o600);
  return target;
}

async function ensureRegularFile(file, target, label, log) {
  if (!file || !/^[a-f0-9]{64}$/.test(file.sha256 || '') || !Number.isSafeInteger(file.size) || typeof file.url !== 'string') throw Error(`${label} 元数据无效`);
  if (await exists(target)) {
    const info = await stat(target);
    if (info.size === file.size && await sha256(target) === file.sha256) return target;
  }
  log(`下载${label}`);
  await download(file.url, target);
  const info = await stat(target);
  if (info.size !== file.size || await sha256(target) !== file.sha256) {
    await rm(target, { force: true });
    throw Error(`${label} 校验失败`);
  }
  await chmod(target, 0o600);
  return target;
}

export async function ensureEmbeddedCores({ log = message => console.log(message), lock = null, includeGeodata = true } = {}) {
  const config = lock || await loadLock();
  const files = {};
  const versionDir = path.join(cacheDir, config.version);
  const licenseFile = await ensureRegularFile(config.licenseFile, path.join(versionDir, 'LICENSE'), `mihomo ${config.version} 许可证`, log);
  for (const arch of ['x86_64', 'arm64']) files[arch] = await ensureAsset(config.assets[arch], config.version, arch, log);
  const geodata = { files: {}, licenseFile: '' };
  if (includeGeodata && config.geodata?.files) {
    const geoDir = path.join(versionDir, 'geo');
    await mkdir(geoDir, { recursive: true, mode: 0o700 });
    for (const [target, file] of Object.entries(config.geodata.files)) geodata.files[target] = await ensureRegularFile(file, path.join(geoDir, target), `Geo 数据 ${target}`, log);
    geodata.licenseFile = await ensureRegularFile(config.geodata.licenseFile, path.join(geoDir, 'LICENSE-meta-rules-dat.txt'), 'Geo 数据许可证', log);
  }
  return { lock: config, files, licenseFile, geodata, cacheDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await ensureEmbeddedCores();
    console.log(`内置 Core 就绪：mihomo ${result.lock.version}（x86_64 / arm64）`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
