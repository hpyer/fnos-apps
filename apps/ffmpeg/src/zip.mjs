import { createReadStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { crc32, createInflateRaw } from 'node:zlib';

// Component archives contain exactly one regular executable. No ZIP entry controls an output path.
export async function extractComponent(archive, destination, tool, { signal } = {}) {
  if (!['ffmpeg', 'ffprobe'].includes(tool)) throw Error('组件名无效');
  const file = await open(archive, 'r');
  let input, decoder, output, created = false;
  const target = path.join(destination, 'bin', tool);
  try {
    const total = (await file.stat()).size;
    if (total < 22 || total > 320 * 1024 * 1024) throw Error('ZIP 大小无效');
    const tail = Buffer.alloc(Math.min(total, 65557)); await file.read(tail, 0, tail.length, total - tail.length);
    let end = tail.length - 22;
    while (end >= 0 && !(tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length)) end--;
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== 1 || tail.readUInt16LE(end + 10) !== 1) throw Error('ZIP 必须仅包含一个组件文件');
    const centralSize = tail.readUInt32LE(end + 12), centralOffset = tail.readUInt32LE(end + 16);
    if (centralSize < 46 || centralSize > 4096 || centralOffset + centralSize !== total - tail.length + end) throw Error('ZIP 目录无效');
    const central = Buffer.alloc(centralSize); await file.read(central, 0, centralSize, centralOffset);
    if (central.readUInt32LE(0) !== 0x02014b50) throw Error('ZIP 文件头无效');
    const flags = central.readUInt16LE(8), method = central.readUInt16LE(10), expectedCRC = central.readUInt32LE(16);
    const compressed = central.readUInt32LE(20), expanded = central.readUInt32LE(24), nameLength = central.readUInt16LE(28);
    const mode = central.readUInt32LE(38) >>> 16, localOffset = central.readUInt32LE(42);
    if ((flags & ~0x80e) || ![0, 8].includes(method) || central.readUInt16LE(34) || (mode & 0o170000) !== 0o100000 ||
        centralSize !== 46 + nameLength + central.readUInt16LE(30) + central.readUInt16LE(32) ||
        central.subarray(46, 46 + nameLength).toString('utf8') !== tool || !expanded || expanded > 256 * 1024 * 1024 || !compressed) throw Error('ZIP 含不支持的文件、链接或大小');
    if (localOffset + 30 > centralOffset) throw Error('ZIP 文件位置无效');
    const local = Buffer.alloc(30); await file.read(local, 0, 30, localOffset);
    const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || localNameLength !== nameLength) throw Error('ZIP 本地文件头无效');
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start + compressed > centralOffset) throw Error('ZIP 数据越界');
    const localName = Buffer.alloc(localNameLength); await file.read(localName, 0, localNameLength, localOffset + 30);
    if (localName.toString('utf8') !== tool) throw Error('ZIP 文件名不一致');
    await mkdir(path.join(destination, 'bin'), { recursive: true, mode: 0o755 });
    output = await open(target, 'wx', 0o600);
    created = true;
    input = createReadStream(archive, { start, end: start + compressed - 1, signal });
    let stream = input;
    if (method === 8) {
      decoder = createInflateRaw(); input.on('error', error => decoder.destroy(error)); stream = input.pipe(decoder);
    }
    let size = 0, crc = 0;
    for await (const chunk of stream) {
      signal?.throwIfAborted(); size += chunk.length;
      if (size > expanded) throw Error('ZIP 解压大小不符');
      crc = crc32(chunk, crc); await output.writeFile(chunk);
    }
    if (size !== expanded || crc !== expectedCRC) throw Error('ZIP CRC 或大小校验失败');
  } catch (error) { await output?.close(); output = null; if (created) await rm(target, { force: true }); throw error; }
  finally { input?.destroy(); decoder?.destroy(); await output?.close(); await file.close(); }
}
