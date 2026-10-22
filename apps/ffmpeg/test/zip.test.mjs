import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractComponent } from '../src/zip.mjs';

function zip({ name = 'ffmpeg', mode = 0o100755, flags = 2, corrupt = false } = {}) {
  const data = Buffer.from('test ELF component'), packed = deflateRawSync(data), filename = Buffer.from(name);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(corrupt ? 1 : crc32(data), 16);
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((mode * 65536) >>> 0, 38);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + packed.length, 16);
  return Buffer.concat([local, filename, packed, central, filename, end]);
}
async function fixture(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-zip-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
test('ZIP 仅提取指定组件，验证 CRC 和展开大小', async t => {
  const root = await fixture(t), archive = path.join(root, 'component.zip');
  await writeFile(archive, zip());
  await extractComponent(archive, root, 'ffmpeg');
  assert.equal(await readFile(path.join(root, 'bin/ffmpeg'), 'utf8'), 'test ELF component');
  await assert.rejects(extractComponent(archive, root, 'ffmpeg'), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(root, 'bin/ffmpeg'), 'utf8'), 'test ELF component');
});
test('ZIP 拒绝路径穿越、符号链接、加密和错误组件，损坏文件不留部分输出', async t => {
  const root = await fixture(t);
  for (const [index, options] of [{ name: '../escape' }, { mode: 0o120777 }, { flags: 1 }, { name: 'ffprobe' }, { corrupt: true }].entries()) {
    const directory = path.join(root, String(index)); await mkdir(directory);
    const archive = path.join(directory, 'component.zip'); await writeFile(archive, zip(options));
    await assert.rejects(extractComponent(archive, directory, 'ffmpeg'), /ZIP/);
    await assert.rejects(stat(path.join(directory, 'bin/ffmpeg')), { code: 'ENOENT' });
  }
});
test('ZIP 拒绝截断目录、越界数据和包含多个条目的包', async t => {
  const root = await fixture(t);
  for (const [index, modify] of [data => data.subarray(0, data.length - 4), data => { data.writeUInt32LE(99999999, data.length - 6); return data; }, data => { data.writeUInt16LE(2, data.length - 12); return data; }].entries()) {
    const archive = path.join(root, `${index}.zip`); await writeFile(archive, modify(zip()));
    await assert.rejects(extractComponent(archive, path.join(root, String(index)), 'ffmpeg'), /ZIP/);
  }
});
