import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

// Only regular files selected by this reader are written. tar never chooses output paths.
// Limit both decompressor memory and total decompressed bytes before executing any payload.
const MAX_EXPANDED = 1536 * 1024 * 1024;
const MAX_BINARY = 512 * 1024 * 1024;
class Reader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); this.total = 0; }
  async next() {
    const { value, done } = await this.iterator.next();
    if (done) throw Error('压缩包意外结束');
    this.total += value.length;
    if (this.total > MAX_EXPANDED) throw Error('解压大小超过限制');
    this.buffer = value;
  }
  async consume(size, write) {
    while (size) {
      if (!this.buffer.length) await this.next();
      const part = this.buffer.subarray(0, Math.min(this.buffer.length, size));
      if (write) await write(part);
      this.buffer = this.buffer.subarray(part.length); size -= part.length;
    }
  }
  async read(size) {
    const chunks = []; await this.consume(size, part => { chunks.push(part); });
    return Buffer.concat(chunks);
  }
}
function field(header, start, length) { return header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, ''); }
function octal(header, start, length) {
  const value = field(header, start, length).trim();
  if (!/^[0-7]+$/.test(value)) throw Error('压缩包数值字段无效');
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw Error('压缩包文件过大');
  return number;
}
function safePath(value, prefix) {
  if (!value || /[\x00-\x1f\x7f\\]/.test(value) || value.startsWith('/') || value.split('/').some(part => part === '..' || part === '.')) throw Error('压缩包含不安全路径');
  if (value !== prefix && !value.startsWith(prefix + '/')) throw Error('压缩包顶层目录不符');
  return value;
}
export async function readTar(stream, destination, prefix, { tools = ['ffmpeg', 'ffprobe'] } = {}) {
  if (!tools.length || tools.some(tool => !['ffmpeg', 'ffprobe'].includes(tool))) throw Error('组件名无效');
  const reader = new Reader(stream), found = new Set();
  let longName = '', headers = 0;
  await mkdir(path.join(destination, 'bin'), { recursive: true, mode: 0o755 });
  while (true) {
    const header = await reader.read(512);
    if (header.every(byte => byte === 0)) {
      if (!(await reader.read(512)).every(byte => byte === 0) || longName) throw Error('压缩包结束标记无效');
      // Drain xz to verify its checksum too, while enforcing the expansion limit.
      if (reader.buffer.some(byte => byte !== 0)) throw Error('压缩包含尾随数据');
      reader.buffer = Buffer.alloc(0);
      for await (const chunk of { [Symbol.asyncIterator]: () => reader.iterator }) {
        reader.total += chunk.length;
        if (reader.total > MAX_EXPANDED || chunk.some(byte => byte !== 0)) throw Error('压缩包含异常尾随数据');
      }
      break;
    }
    if (++headers > 10000) throw Error('压缩包文件数量过多');
    const expected = octal(header, 148, 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (expected !== actual) throw Error('压缩包头部校验失败');
    const size = octal(header, 124, 12), type = field(header, 156, 1);
    if (size > MAX_EXPANDED) throw Error('压缩包条目过大');
    if (type === 'L') {
      if (longName || size > 4096) throw Error('压缩包长文件名无效');
      longName = (await reader.read(size)).toString('utf8').replace(/\0$/, '');
    } else {
      const prefixField = field(header, 345, 155);
      const rawName = longName || (prefixField ? prefixField + '/' : '') + field(header, 0, 100);
      longName = '';
      const name = safePath(rawName.replace(/\/$/, ''), prefix);
      if (!['', '0', '5'].includes(type) || (type === '5' && size)) throw Error('压缩包含链接或不支持的文件类型');
      const relative = name.slice(prefix.length + 1);
      const selected = [...tools.map(tool => `bin/${tool}`), 'LICENSE.txt'].includes(relative);
      if (selected) {
        if (type === '5' || found.has(relative) || size === 0 || size > (relative === 'LICENSE.txt' ? 1024 * 1024 : MAX_BINARY)) throw Error('压缩包文件无效或重复');
        const file = await open(path.join(destination, relative), 'wx', 0o600);
        try { await reader.consume(size, part => file.writeFile(part)); } finally { await file.close(); }
        found.add(relative);
      } else { await reader.consume(size); }
    }
    await reader.consume((512 - size % 512) % 512);
  }
  if (tools.some(tool => !found.has(`bin/${tool}`)) || !found.has('LICENSE.txt')) throw Error('压缩包缺少所需组件或 LICENSE.txt');
}
export async function extractArchive(archive, destination, prefix, { signal, xz = '/usr/bin/xz', tools } = {}) {
  const child = spawn(xz, ['--decompress', '--stdout', '--memlimit-decompress=256MiB', '--', archive], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, signal });
  let output = '';
  child.stderr.on('data', data => { output = (output + data).slice(-2048); });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(`解压失败：${output.trim() || code}`)));
  });
  completed.catch(() => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  try { await readTar(child.stdout, destination, prefix, { tools }); await completed; }
  finally { clearTimeout(timer); child.kill('SIGKILL'); await completed.catch(() => {}); }
}
