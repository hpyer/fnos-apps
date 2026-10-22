import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ComponentRepository, parseComponentIndex } from '../src/components.mjs';
import { downloadVerified, MAX_DOWNLOAD } from '../src/download.mjs';

const payload = 'abcdefghij';
const sha256 = createHash('sha256').update(payload).digest('hex');
const terminated = () => Object.assign(new TypeError('terminated'), { cause: Object.assign(Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
function interrupted(text = 'abc') {
  let sent = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (sent) controller.error(terminated());
    else { sent = true; controller.enqueue(Buffer.from(text)); }
  } }), { headers: { 'content-length': String(payload.length), etag: '"build-one"' } });
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { destination: path.join(directory, 'archive.zip'), sha256, size: payload.length, retryBaseMs: 1 };
}
async function missing(file) { await assert.rejects(stat(file), { code: 'ENOENT' }); }

test('真实 HTTP 下载在中途断开后，独立组件按 Range + If-Range 续传且验证完整 SHA256', async t => {
  const options = await fixture(t), requests = [], retries = [], progress = [];
  const server = http.createServer((request, response) => {
    requests.push(request.headers);
    if (requests.length === 1) {
      response.writeHead(200, { 'content-length': payload.length, etag: '"build-one"' });
      response.write(payload.slice(0, 4));
      setTimeout(() => response.destroy(), 40);
    } else {
      response.writeHead(206, { 'content-length': 6, 'content-range': 'bytes 4-9/10', etag: '"build-one"' });
      response.end(payload.slice(4));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const repository = new ComponentRepository({ platform: 'linux', arch: 'x64', fetcher: (url, settings) => fetch(`http://127.0.0.1:${server.address().port}/archive`, settings) });
  const [entry] = parseComponentIndex('<h2>Download Release Build</h2><a href="/download/linux/amd64/1789931100_9.0.2/ffmpeg.zip">FFmpeg</a>', 'x64');
  Object.assign(entry.components.ffmpeg, { sha256, size: payload.length });
  await repository.downloadComponent(entry, 'ffmpeg', options.destination, { retryBaseMs: 1, retry: info => retries.push(info), progress: n => progress.push(n) });
  assert.equal(await readFile(options.destination, 'utf8'), payload);
  assert.equal(requests.length, 2); assert.equal(requests[1].range, 'bytes=4-'); assert.equal(requests[1]['if-range'], '"build-one"');
  // Node fetch appends identity for a Range request, even when explicitly supplied.
  for (const request of requests) assert.deepEqual([...new Set(request['accept-encoding'].split(',').map(item => item.trim()))], ['identity']);
  assert.equal(retries.length, 1); assert.equal(retries[0].received, 4); assert.equal(progress.at(-1), payload.length);
});
test('服务器忽略 Range 返回 200 时清空部分文件重下，不将整份文件追加到残片后', async t => {
  const options = await fixture(t), ranges = [], progress = [];
  await downloadVerified({ ...options, request: async ({ headers }) => {
    ranges.push(headers.range);
    return ranges.length === 1 ? interrupted() : new Response(payload, { headers: { 'content-length': String(payload.length) } });
  }, progress: n => progress.push(n) });
  assert.equal(await readFile(options.destination, 'utf8'), payload);
  assert.deepEqual(ranges, [undefined, 'bytes=3-']); assert.ok(progress.includes(0));
});
test('续传 416 会重新完整下载；重定向仍传递续传请求头', async t => {
  const options = await fixture(t), headers = [];
  const repository = new ComponentRepository({ fetcher: async (url, settings) => {
    headers.push(settings.headers);
    return headers.length === 1 ? new Response(null, { status: 302, headers: { location: url.replace('ffmpeg.zip', 'ffprobe.zip') } }) : new Response(payload);
  } });
  await repository.response('https://ffmpeg.martin-riedl.de/download/linux/amd64/1789931100_9.0.2/ffmpeg.zip', { headers: { range: 'bytes=3-', 'if-range': '"build-one"' } });
  assert.equal(headers[1].range, 'bytes=3-'); assert.equal(headers[1]['if-range'], '"build-one"');
  const ranges = [];
  await downloadVerified({ ...options, request: async ({ headers }) => {
    ranges.push(headers.range);
    if (ranges.length === 1) return interrupted();
    if (ranges.length === 2) throw Object.assign(Error('HTTP 416'), { status: 416 });
    return new Response(payload);
  } });
  assert.deepEqual(ranges, [undefined, 'bytes=3-', undefined]); assert.equal(await readFile(options.destination, 'utf8'), payload);
});
test('错误的 Content-Range、变更的内容、超大响应和永久 HTTP 错误不继续重试', async t => {
  const root = await fixture(t);
  for (const [name, response, pattern] of [
    ['range', () => new Response(payload.slice(3), { status: 206, headers: { 'content-range': 'bytes 0-6/10' } }), /范围/],
    ['hash', () => new Response('0123456789'), /SHA256/],
    ['size', () => new Response(payload, { headers: { 'content-length': String(MAX_DOWNLOAD + 1) } }), /超过限制/],
    ['forbidden', () => { throw Object.assign(Error('HTTP 403'), { status: 403 }); }, /HTTP 403/],
  ]) {
    let calls = 0; const destination = root.destination + name;
    await assert.rejects(downloadVerified({ ...root, destination, request: async () => ++calls === 1 ? interrupted() : response() }), pattern);
    assert.equal(calls, 2); await missing(destination);
  }
});
test('连续断连最多重试三次，给出可读错误并清理残片，已有同名文件不受影响', async t => {
  const options = await fixture(t); let calls = 0;
  await assert.rejects(downloadVerified({ ...options, label: 'ffmpeg', request: async () => { calls++; return interrupted(); } }), error => {
    // Repeated 200 responses restart safely, rather than growing a corrupted file.
    assert.match(error.message, /ffmpeg.*下载连接中断.*UND_ERR_SOCKET.*重试 3 次/);
    assert.doesNotMatch(error.message, /terminated/); return true;
  });
  assert.equal(calls, 4); await missing(options.destination);
  await writeFile(options.destination, 'keep');
  await assert.rejects(downloadVerified({ ...options, request: async () => { throw Error('must not request'); } }), { code: 'EEXIST' });
  assert.equal(await readFile(options.destination, 'utf8'), 'keep');
});
test('未知体积可从 Content-Range 获取总大小，续传后仍拒绝 SHA256 不匹配的内容', async t => {
  const root = await fixture(t);
  for (const corrupt of [false, true]) {
    let calls = 0; const destination = root.destination + corrupt;
    const downloading = downloadVerified({ ...root, destination, size: null, request: async () => {
      if (++calls === 1) { const response = interrupted(); response.headers.delete('content-length'); return response; }
      return new Response(corrupt ? 'XXXXXXX' : payload.slice(3), { status: 206, headers: { 'content-range': 'bytes 3-9/10', 'content-length': '7' } });
    } });
    if (corrupt) { await assert.rejects(downloading, /SHA256/); await missing(destination); }
    else { assert.equal(await downloading, payload.length); assert.equal(await readFile(destination, 'utf8'), payload); }
    assert.equal(calls, 2);
  }
});
test('重试等待期间取消立即停止；停滞连接和整体超时均清理暂存', async t => {
  const options = await fixture(t), controller = new AbortController(); let calls = 0;
  await assert.rejects(downloadVerified({ ...options, signal: controller.signal, retry: () => controller.abort(), request: async () => { calls++; return interrupted(); } }), /已取消/);
  assert.equal(calls, 1); await missing(options.destination);
  const stuck = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  calls = 0;
  await assert.rejects(downloadVerified({ ...options, idleTimeoutMs: 10, request: settings => { calls++; return stuck(settings); } }), /长时间未响应.*重试 3 次/);
  assert.equal(calls, 4); await missing(options.destination);
  await assert.rejects(downloadVerified({ ...options, timeoutMs: 15, idleTimeoutMs: 100, request: stuck }), /下载超时/);
  await missing(options.destination);
  calls = 0;
  await assert.rejects(downloadVerified({ ...options, idleTimeoutMs: 10, request: async ({ signal }) => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('abc'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
  } }), /长时间未响应.*重试 3 次/);
  assert.equal(calls, 4); await missing(options.destination);
});
