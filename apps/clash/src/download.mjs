import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { AppError, fail } from './errors.mjs';

export const MAX_CORE_DOWNLOAD = 128 * 1024 * 1024;
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
const RETRY_STATUS = new Set([408, 500, 502, 503, 504]);

function networkCode(error) {
  for (let depth = 0; error && depth < 5; depth += 1, error = error.cause) {
    if (NETWORK_CODES.has(error.code)) return error.code;
  }
  return '';
}

function transient(error) {
  return error.retryable || RETRY_STATUS.has(error.status) || networkCode(error) ||
    (error instanceof TypeError && ['terminated', 'fetch failed'].includes(error.message));
}

/**
 * Download one file to a new path, enforcing a pinned SHA256 and size.
 * The caller's request function must perform its own origin/redirect checks.
 */
export async function downloadVerified({ url, destination, sha256, size, request, signal, progress = () => {}, label = '文件',
  timeoutMs = 10 * 60 * 1000, retryBaseMs = 800, maxSize = MAX_CORE_DOWNLOAD }) {
  if (!/^[a-f0-9]{64}$/.test(sha256 || '') || !Number.isSafeInteger(size) || size <= 0 || size > maxSize) fail('下载元数据无效，请重新检查版本');
  const maxRetries = 3;
  const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      operationSignal.throwIfAborted();
      const controller = new AbortController();
      const attemptSignal = AbortSignal.any([operationSignal, controller.signal]);
      const timer = setTimeout(() => controller.abort(Error('下载连接长时间未响应')), 60000);
      let response;
      try {
        response = await request(url, { signal: attemptSignal, headers: { 'accept-encoding': 'identity' } });
        if (!response.ok || !response.body) throw Object.assign(Error(`文件下载请求失败：HTTP ${response.status}`), { status: response.status });
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > 0 && declared !== size) throw Error('下载文件大小与版本记录不符');
        const file = await open(destination, 'wx', 0o600);
        const hash = createHash('sha256');
        let received = 0;
        try {
          for await (const chunk of response.body) {
            operationSignal.throwIfAborted();
            received += chunk.length;
            if (received > size || received > maxSize) throw Error('下载文件超过预期大小');
            let written = 0;
            while (written < chunk.length) {
              const result = await file.write(chunk, written, chunk.length - written, received - chunk.length + written);
              if (!result.bytesWritten) throw Error('下载文件写入失败');
              written += result.bytesWritten;
            }
            hash.update(chunk);
            progress(received, size);
          }
        } finally {
          await file.close();
        }
        if (received !== size) throw Object.assign(Error('下载文件大小不符，传输提前结束'), { retryable: true });
        if (hash.digest('hex') !== sha256) throw Error('下载文件 SHA256 校验失败');
        return received;
      } finally {
        clearTimeout(timer);
        await response?.body?.cancel().catch(() => {});
        controller.abort();
      }
    } catch (error) {
      lastError = error;
      await rm(destination, { force: true });
      if (operationSignal.aborted) break;
      if (!transient(error) || attempt >= maxRetries) break;
      await new Promise(resolve => setTimeout(resolve, retryBaseMs * 2 ** attempt));
    }
  }
  if (signal?.aborted) fail(`${label}下载已取消`);
  if (operationSignal.aborted) fail(`${label}下载超时，请检查 NAS 网络后重试`);
  if (lastError?.code === 'ENOSPC') fail('磁盘空间不足，下载已停止', 507);
  if (['EACCES', 'EPERM'].includes(lastError?.code)) fail('无法写入下载文件，请检查应用数据目录权限');
  fail(`${label}下载失败：${lastError?.message || '未知错误'}`);
}


/** Download without an upstream checksum and return the computed SHA256 (fallback mode). */
export async function downloadUnverified({ url, destination, request, signal, progress = () => {}, label = 'Core', maxBytes = MAX_CORE_DOWNLOAD, timeoutMs = 10 * 60 * 1000 }) {
  const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let lastError;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    try {
      operationSignal.throwIfAborted();
      const response = await request(url, { signal: operationSignal, headers: { 'accept-encoding': 'identity' } });
      if (!response.ok || !response.body) throw Object.assign(Error(`文件下载请求失败：HTTP ${response.status}`), { status: response.status });
      const file = await open(destination, 'wx', 0o600);
      const hash = createHash('sha256');
      let received = 0;
      try {
        for await (const chunk of response.body) {
          operationSignal.throwIfAborted();
          received += chunk.length;
          if (received > maxBytes) throw Error('下载文件超过大小限制');
          let written = 0;
          while (written < chunk.length) {
            const result = await file.write(chunk, written, chunk.length - written, received - chunk.length + written);
            if (!result.bytesWritten) throw Error('下载文件写入失败');
            written += result.bytesWritten;
          }
          hash.update(chunk);
          progress(received, 0);
        }
      } finally {
        await file.close();
      }
      return { size: received, sha256: hash.digest('hex') };
    } catch (error) {
      lastError = error;
      await rm(destination, { force: true }).catch(() => {});
      if (signal?.aborted || !transient(error) || attempt >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 800 * 2 ** attempt));
    }
  }
  if (signal?.aborted) fail(`${label}下载已取消`);
  if (lastError?.code === 'ENOSPC') fail('磁盘空间不足，下载已停止', 507);
  fail(`${label}下载失败：${lastError?.message || '未知错误'}`);
}

/** Download a small text document (subscription or configuration) with a hard size limit. */
export async function downloadText({ url, request, maxBytes = 8 * 1024 * 1024, signal, timeoutMs = 30000, label = '订阅内容' }) {
  const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await request(url, { signal: operationSignal, headers: { 'accept-encoding': 'identity' } });
  } catch (error) {
    if (signal?.aborted) fail(`${label}下载已取消`);
    if (operationSignal.aborted) fail(`${label}下载超时`);
    fail(`${label}下载失败：${error.message}`);
  }
  try {
    if (!response.ok || !response.body) fail(`${label}下载失败：HTTP ${response.status}`, response.status === 404 ? 404 : 400);
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > maxBytes) fail(`${label}超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MiB 限制`);
      chunks.push(Buffer.from(chunk));
    }
    if (!received) fail(`${label}为空`);
    return { text: Buffer.concat(chunks).toString('utf8'), etag: response.headers.get('etag') || '', lastModified: response.headers.get('last-modified') || '', size: received };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal?.aborted) fail(`${label}下载已取消`);
    fail(`${label}下载失败：${error.message}`);
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}
