import { build } from 'esbuild';
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = fileURLToPath(new URL('./', import.meta.url));
const target = path.join(root, 'dist', 'dnsmasq');
const version = /^version\s*=\s*(\d+\.\d+\.\d+)\s*$/m.exec(await readFile(path.join(source, 'native/manifest'), 'utf8'))?.[1];
if (!version) throw new Error('manifest 缺少有效版本号');
await rm(target, { recursive: true, force: true });
await cp(path.join(source, 'native'), target, { recursive: true });
await mkdir(path.join(target, 'app'), { recursive: true });
await writeFile(path.join(target, 'app/version'), `version = ${version}\n`);
await cp(path.join(source, 'src'), path.join(target, 'app'), { recursive: true });
const privilege = path.join(target, 'app/node_modules/@fnos/privilege');
await mkdir(path.join(privilege, 'src'), { recursive: true });
await cp(path.join(source, '../../packages/privilege/package.json'), path.join(privilege, 'package.json'));
await cp(path.join(source, '../../packages/privilege/src'), path.join(privilege, 'src'), { recursive: true });
await build({ entryPoints: [path.join(source, 'src/web/index.js'), path.join(source, 'src/web/index.css')], outdir: path.join(target, 'app/web'), bundle: true, platform: 'browser', target: 'es2022', format: 'esm', logLevel: 'warning' });
const supplied = process.env.DNSMASQ_BINARY;
if (supplied) {
  await mkdir(path.join(target, 'app/bin'), { recursive: true }); await cp(supplied, path.join(target, 'app/bin/dnsmasq')); await chmod(path.join(target, 'app/bin/dnsmasq'), 0o755);
  const license = path.join(path.dirname(supplied), 'COPYING');
  try { await cp(license, path.join(target, 'app/bin/COPYING-dnsmasq')); } catch { console.warn('未找到 dnsmasq COPYING：发布前必须补齐许可证文件'); }
}
else console.warn('未注入 dnsmasq 二进制：请在 Linux x86_64/arm64 构建机设置 DNSMASQ_BINARY 后再打包');
async function normalize(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); const relative = path.relative(target, full).split(path.sep).join('/'); if (entry.isDirectory()) { await chmod(full, 0o755); await normalize(full); } else if (entry.isFile()) await chmod(full, relative.startsWith('cmd/') || relative.startsWith('app/bin/') ? 0o755 : 0o644); } }
await normalize(target);
console.log(`已构建 ${target}（dnsmasq ${version}，二进制${supplied ? '已注入' : '待注入'}）`);
