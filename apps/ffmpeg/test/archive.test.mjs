import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTar } from '../src/archive.mjs';

const prefix = 'ffmpeg-test';
function entry(name, data = '', type = '0') {
  data = Buffer.from(data); const header = Buffer.alloc(512);
  header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const files = () => [entry(`${prefix}/bin/ffmpeg`, 'ffmpeg'), entry(`${prefix}/bin/ffprobe`, 'ffprobe'), entry(`${prefix}/LICENSE.txt`, 'GPL license')];
function archive(entries) { return Buffer.concat([...entries, Buffer.alloc(1024)]); }
async function fixture(t) { const directory = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-archive-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
test('跨数据块读取 tar，只落盘两个命令和许可证', async t => {
  const directory = await fixture(t), buffer = archive([...files(), entry(`${prefix}/doc/info.html`, 'ignored')]);
  const chunks = []; for (let offset = 0; offset < buffer.length; offset += 113) chunks.push(buffer.subarray(offset, offset + 113));
  await readTar(Readable.from(chunks), directory, prefix);
  assert.equal(await readFile(path.join(directory, 'bin/ffmpeg'), 'utf8'), 'ffmpeg');
  assert.deepEqual((await readdir(directory)).sort(), ['LICENSE.txt', 'bin']);
});
test('拒绝目录逃逸、绝对路径、链接、重复文件和损坏包头', async t => {
  const directory = await fixture(t);
  const cases = [entry('../outside', 'bad'), entry(`/${prefix}/bin/ffmpeg`, 'bad'), entry(`${prefix}/bin/ffmpeg`, '', '2'), entry(`${prefix}/bin/ffmpeg`, '', '1'), entry(`${prefix}/bin/ffmpeg`, 'duplicate')];
  for (let index = 0; index < cases.length; index++) {
    await assert.rejects(readTar(Readable.from([archive([...files(), cases[index]])]), path.join(directory, String(index)), prefix), /不安全路径|不支持的文件类型|重复/);
  }
  const corrupt = archive(files()); corrupt[0] = 0;
  await assert.rejects(readTar(Readable.from([corrupt]), path.join(directory, 'corrupt'), prefix), /头部校验/);
  await assert.rejects(stat(path.join(directory, '../outside')), { code: 'ENOENT' });
});
test('拒绝缺失文件、截断数据和非零尾随数据', async t => {
  const directory = await fixture(t);
  await assert.rejects(readTar(Readable.from([archive(files().slice(0, 1))]), path.join(directory, 'missing'), prefix), /缺少/);
  await assert.rejects(readTar(Readable.from([archive(files()).subarray(0, 800)]), path.join(directory, 'truncated'), prefix), /意外结束/);
  await assert.rejects(readTar(Readable.from([Buffer.concat([archive(files()), Buffer.from('unexpected')])]), path.join(directory, 'trailing'), prefix), /尾随数据/);
});
test('GNU 长文件名也必须经过路径校验', async t => {
  const directory = await fixture(t);
  await assert.rejects(readTar(Readable.from([archive([entry('././@LongLink', '../outside\0', 'L'), entry('placeholder', 'bad'), ...files()])]), directory, prefix), /不安全路径/);
});
