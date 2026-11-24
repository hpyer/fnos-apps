import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { architectureName } from './runtime.mjs';

// One-off helper for producing the Debian 12 runtime assets published in the
// `dnsmasq-runtime-<version>` release. Release builds download the verified
// assets instead of compiling (see scripts/runtime.mjs).
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(path.join(root, 'core-versions.lock'), 'utf8'));
const version = lock.version;
const arch = process.argv[2] || process.arch;
if (process.platform !== 'linux') throw new Error('dnsmasq 目标二进制必须在 Debian 12 (Linux) 构建机生成；当前主机不是 Linux');
const target = architectureName(arch);
if (!target) throw new Error(`不支持的构建架构：${arch}`);
const out = path.join(root, 'binaries', target, 'dnsmasq');
const license = path.join(root, 'binaries', target, 'COPYING');
const tmp = path.join(root, '.local', `dnsmasq-${version}-${target}`);
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });
await mkdir(path.dirname(out), { recursive: true });

async function run(binary, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(`${binary} exited ${code}`)));
  });
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
    await handle.read(header, 0, header.length, 0);
    return header.readUInt16LE(18);
  } finally { await handle.close(); }
}

const tarball = path.join(tmp, 'dnsmasq.tar.xz');
await run('curl', ['-L', '--fail', '--retry', '3', lock.source, '-o', tarball], tmp);
const sourceHash = await sha256(tarball);
if (sourceHash !== lock.sourceSha256) throw new Error(`源码包 SHA-256 与 core-versions.lock 不符：${sourceHash}`);
await run('tar', ['-xJf', 'dnsmasq.tar.xz'], tmp);
const source = path.join(tmp, `dnsmasq-${version}`);
await run('make', ['-C', source, 'COPTS=-DNO_ID'], tmp);
await run('cp', [path.join(source, 'src/dnsmasq'), out], tmp);
await run('cp', [path.join(source, 'COPYING'), license], tmp);
await run('chmod', ['0755', out], tmp);

const expected = lock.assets[target];
const binaryHash = await sha256(out);
const binarySize = (await stat(out)).size;
const machine = await elfMachine(out);
const licenseHash = await sha256(license);
const licenseSize = (await stat(license)).size;
console.log(`已生成 ${target} 运行时：${binarySize} 字节，machine ${machine}`);
console.log(`  dnsmasq  ${binaryHash}`);
console.log(`  COPYING  ${licenseHash}（${licenseSize} 字节）`);
if (binaryHash !== expected.sha256 || binarySize !== expected.size) {
  console.log('该产物与 core-versions.lock 记录不同；若为主动升级运行时，请发布产物并更新锁文件。');
}
