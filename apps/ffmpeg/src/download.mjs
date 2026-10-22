import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export const MAX_DOWNLOAD = 320 * 1024 * 1024;
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
const RETRY_STATUS = new Set([408, 500, 502, 503, 504]);
function networkCode(error) {
  for (let depth = 0; error && depth < 5; depth++, error = error.cause) if (NETWORK_CODES.has(error.code)) return error.code;
}
function transient(error) {
  return error.retryable || RETRY_STATUS.has(error.status) || networkCode(error) ||
    (error instanceof TypeError && ['terminated', 'fetch failed'].includes(error.message));
}
function length(value) { return /^\d+$/.test(value || '') && Number.isSafeInteger(Number(value)) ? Number(value) : null; }
function readableSize(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }
function validator(headers) {
  const tag = headers.get('etag');
  if (/^"[^"\r\n]*"$/.test(tag || '')) return tag;
  const modified = headers.get('last-modified');
  return modified && Number.isFinite(Date.parse(modified)) ? modified : undefined;
}

// Resume only within this operation, against a fixed upstream URL and mandatory SHA256.
// Every retry goes through the repository's redirect/origin checks again.
export async function downloadVerified({ destination, sha256, size: expectedSize = null, request, signal, progress = () => {}, retry = () => {},
  label = '文件', timeoutMs = 30 * 60 * 1000, idleTimeoutMs = 60000, retryBaseMs = 1000 }) {
  if (!/^[a-f0-9]{64}$/.test(sha256) || (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_DOWNLOAD))) throw Error('下载文件大小或 SHA256 元数据无效');
  const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const maxRetries = 3;
  let file, received = 0, hash = createHash('sha256'), ifRange;
  async function restart() {
    await file.truncate(0); received = 0; hash = createHash('sha256'); ifRange = undefined;
    progress(0, expectedSize || 0);
  }
  try {
    operationSignal.throwIfAborted();
    file = await open(destination, 'wx', 0o600);
    for (let attempt = 0; ; attempt++) {
      operationSignal.throwIfAborted();
      const controller = new AbortController();
      const attemptSignal = AbortSignal.any([operationSignal, controller.signal]);
      let response, timer;
      const resetTimer = ms => { clearTimeout(timer); timer = setTimeout(() => controller.abort(Error('下载连接长时间未响应')), ms); };
      try {
        resetTimer(Math.min(idleTimeoutMs, 30000));
        const offset = received;
        const headers = { 'accept-encoding': 'identity', ...(offset ? { range: `bytes=${offset}-`, ...(ifRange ? { 'if-range': ifRange } : {}) } : {}) };
        response = await request({ signal: attemptSignal, headers });
        resetTimer(idleTimeoutMs);
        const encoding = response.headers.get('content-encoding');
        if (encoding && encoding.toLowerCase() !== 'identity') throw Error('文件服务器返回了不支持的压缩编码');
        const declared = length(response.headers.get('content-length'));
        let responseSize = declared;
        if (response.status === 206) {
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
          const values = match?.slice(1).map(Number);
          if (!offset || !values?.every(Number.isSafeInteger)) throw Error('续传响应 Content-Range 无效');
          const [start, end, total] = values;
          if (start !== offset || end < start || total <= end || total > MAX_DOWNLOAD ||
              (expectedSize !== null && total !== expectedSize) || (declared !== null && declared !== end - start + 1)) throw Error('续传响应范围或文件大小不符');
          expectedSize = total;
          responseSize = end - start + 1;
        } else if (response.status === 200) {
          // If Range is ignored or If-Range no longer matches, never append the full response.
          if (offset) await restart();
          if (declared !== null && (declared <= 0 || declared > MAX_DOWNLOAD)) throw Error('下载文件大小超过限制');
          if (expectedSize !== null && declared !== null && expectedSize !== declared) throw Error('下载文件大小不符，请重新检查版本');
          expectedSize ??= declared;
        } else throw Object.assign(Error(`文件下载请求失败：HTTP ${response.status}`), { status: response.status });
        ifRange = validator(response.headers);
        if (!response.body) throw Error('文件服务器未返回下载内容');
        const responseStart = received;
        for await (const chunk of response.body) {
          operationSignal.throwIfAborted(); resetTimer(idleTimeoutMs);
          if (received + chunk.length > MAX_DOWNLOAD || (expectedSize !== null && received + chunk.length > expectedSize) ||
              (responseSize !== null && received + chunk.length - responseStart > responseSize)) throw Error('下载文件大小不符');
          let written = 0;
          while (written < chunk.length) {
            const result = await file.write(chunk, written, chunk.length - written, received + written);
            if (!result.bytesWritten) throw Error('下载文件写入失败'); written += result.bytesWritten;
          }
          hash.update(chunk); received += chunk.length; progress(received, expectedSize || 0);
        }
        if ((expectedSize !== null && received !== expectedSize) || (responseSize !== null && received - responseStart !== responseSize)) throw Object.assign(Error('下载文件大小不符，传输提前结束'), { retryable: true, shortRead: true });
        break;
      } catch (error) {
        if (operationSignal.aborted) throw error;
        const rangeRejected = error.status === 416 && received > 0;
        const retryable = rangeRejected || controller.signal.aborted || transient(error);
        // A close after all expected bytes arrived is harmless only if the final SHA256 also matches.
        if (expectedSize !== null && received === expectedSize && retryable && !rangeRejected) break;
        if (!retryable) throw error;
        if (attempt >= maxRetries) {
          const reason = error.shortRead ? '下载文件大小不符，传输提前结束' : controller.signal.aborted ? '下载连接长时间未响应' :
            error.status ? `文件服务器请求失败（HTTP ${error.status}）` : networkCode(error) ? `下载连接中断（${networkCode(error)}）` : '下载连接中断';
          throw Error(`${label} ${reason}，自动重试 ${maxRetries} 次后仍未完成（已接收 ${readableSize(received)}${expectedSize ? ' / ' + readableSize(expectedSize) : ''}），请检查 NAS 网络后重试`);
        }
        if (rangeRejected) await restart();
        await response?.body?.cancel().catch(() => {}); controller.abort(); clearTimeout(timer);
        retry({ attempt: attempt + 1, maxRetries, received, total: expectedSize || 0 });
        const retryAfter = /^\d+$/.test(error.retryAfter || '') ? Number(error.retryAfter) * 1000 : Math.max(0, Date.parse(error.retryAfter) - Date.now()) || 0;
        await sleep(Math.max(retryBaseMs * 2 ** attempt, Math.min(retryAfter, timeoutMs)), undefined, { signal: operationSignal });
      } finally {
        clearTimeout(timer); await response?.body?.cancel().catch(() => {}); controller.abort();
      }
    }
    if (!received || hash.digest('hex') !== sha256) throw Error('下载文件 SHA256 或大小校验失败');
    return received;
  } catch (error) {
    if (file) { await file.close(); file = null; await rm(destination, { force: true }); }
    if (signal?.aborted) throw Error(`${label} 下载已取消`);
    if (operationSignal.aborted) throw Error(`${label} 下载超时，请检查网络后重试`);
    if (['ENOSPC', 'EDQUOT'].includes(error.code)) throw Error('磁盘空间不足，下载已停止');
    if (['EACCES', 'EPERM'].includes(error.code)) throw Error('无法写入下载文件，请检查应用数据目录权限');
    throw error;
  } finally { await file?.close(); }
}
