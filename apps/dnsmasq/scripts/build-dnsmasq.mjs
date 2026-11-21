import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(new URL('../', import.meta.url))); const version = '2.93'; const url = `https://thekelleys.org.uk/dnsmasq/dnsmasq-${version}.tar.xz`; const arch = process.argv[2] || process.arch;
if (process.platform !== 'linux') throw new Error('dnsmasq 目标二进制必须在 Linux 构建机生成；当前主机不是 Linux'); const target = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'arm64' : ''; if (!target) throw new Error(`不支持的构建架构：${arch}`);
const out = path.join(root, 'binaries', target, 'dnsmasq'); const tmp = path.join(root, '.local', `dnsmasq-${version}-${target}`); await mkdir(path.dirname(out), { recursive: true }); await rm(tmp, { recursive: true, force: true }); await mkdir(tmp, { recursive: true });
async function run(binary, args, cwd) { await new Promise((resolve, reject) => { const child = spawn(binary, args, { cwd, stdio: 'inherit', shell: false }); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(`${binary} exited ${code}`))); }); }
await run('curl', ['-L', '--fail', '--retry', '3', url, '-o', path.join(tmp, 'dnsmasq.tar.xz')], tmp); await run('tar', ['-xf', 'dnsmasq.tar.xz'], tmp); const source = path.join(tmp, `dnsmasq-${version}`); await run('make', ['-C', source, 'COPTS=-DNO_ID'], tmp); await run('cp', [path.join(source, 'src/dnsmasq'), out], tmp); await run('cp', [path.join(source, 'COPYING'), path.join(path.dirname(out), 'COPYING')], tmp); await run('chmod', ['0755', out], tmp); console.log(`已构建 ${out}，请将 core-versions.lock 中的 sha256 替换为该文件的校验值`);
