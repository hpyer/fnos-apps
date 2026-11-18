import { createReadStream } from 'node:fs';
import { chmod, open, rename, rm, stat } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { AppError, fail } from './errors.mjs';
import { elfArchitecture } from './binary.mjs';
import { hashFile } from './storage.mjs';

export const MAX_EXPANDED = 256 * 1024 * 1024;

/**
 * Extract a gzip-compressed mihomo binary into the private core directory.
 * The archive hash, expanded size and ELF architecture are checked before the
 * executable becomes visible. Nothing is ever executed from the compressed file.
 */
export async function extractGzip(archive, destination, { expectedSha256, expectedSize, arch, signal, mode = 0o555, maxSize = MAX_EXPANDED } = {}) {
  const info = await stat(archive).catch(() => fail('下载的 Core 文件不存在'));
  if (info.size > maxSize) fail('Core 压缩包超过大小限制');
  if (expectedSize && info.size !== expectedSize) fail('Core 压缩包大小与锁定信息不符');
  let digest = '';
  if (expectedSha256) {
    digest = await hashFile(archive);
    if (digest !== expectedSha256) fail('Core 下载文件 SHA256 校验失败');
  }
  const temporary = `${destination}.${process.pid}.part`;
  let written = 0;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      const gunzip = createGunzip({ maxOutputLength: maxSize });
      for await (const chunk of createReadStream(archive).pipe(gunzip)) {
        if (signal?.aborted) fail('Core 解压已取消');
        written += chunk.length;
        if (written > maxSize) fail('Core 解压后超过大小限制');
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    const architecture = await elfArchitecture(temporary);
    if (!architecture) fail('Core 不是可执行的静态 Linux ELF 文件');
    if (arch && architecture !== arch) fail(`Core 架构不匹配：需要 ${arch}，实际 ${architecture}`);
    await chmod(temporary, mode);
    await rename(temporary, destination);
    return { size: written, sha256: digest };
  } catch (error) {
    await rm(temporary, { force: true });
    if (error instanceof AppError) throw error;
    if (error.code === 'ENOSPC') fail('磁盘空间不足，无法解压 Core', 507);
    fail(`Core 解压失败：${error.message}`);
  }
}
