import { build } from 'esbuild';
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureEmbeddedDnsmasq } from './scripts/runtime.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = fileURLToPath(new URL('./', import.meta.url));
const target = path.join(root, 'dist', 'dnsmasq-for-fnos');
const version = /^version\s*=\s*(\d+\.\d+\.\d+)\s*$/m.exec(await readFile(path.join(source, 'native/manifest'), 'utf8'))?.[1];
if (!version) throw new Error('manifest 缺少有效版本号');
// Resolve the locked Debian 12 runtime before touching dist so a missing or
// mismatched artifact fails the build without destroying the previous output.
const runtime = await ensureEmbeddedDnsmasq();
await rm(target, { recursive: true, force: true });
await cp(path.join(source, 'native'), target, { recursive: true });
await mkdir(path.join(target, 'app'), { recursive: true });
await writeFile(path.join(target, 'app/version'), `version = ${version}\n`);
await writeFile(path.join(target, 'app/dnsmasq-version'), `${runtime.version}\n`);
await cp(path.join(source, 'src'), path.join(target, 'app'), { recursive: true });
const privilege = path.join(target, 'app/node_modules/@fnos/privilege');
await mkdir(path.join(privilege, 'src'), { recursive: true });
await cp(path.join(source, '../../packages/privilege/package.json'), path.join(privilege, 'package.json'));
await cp(path.join(source, '../../packages/privilege/src'), path.join(privilege, 'src'), { recursive: true });
await build({ entryPoints: [path.join(source, 'src/web/index.js'), path.join(source, 'src/web/index.css')], outdir: path.join(target, 'app/web'), bundle: true, platform: 'browser', target: 'es2022', format: 'esm', logLevel: 'warning' });
const binDir = path.join(target, 'app/bin');
await mkdir(binDir, { recursive: true });
await cp(runtime.binary, path.join(binDir, 'dnsmasq'));
await chmod(path.join(binDir, 'dnsmasq'), 0o755);
await cp(runtime.license, path.join(binDir, 'COPYING-dnsmasq'));
async function normalize(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); const relative = path.relative(target, full).split(path.sep).join('/'); if (entry.isDirectory()) { await chmod(full, 0o755); await normalize(full); } else if (entry.isFile()) await chmod(full, relative.startsWith('cmd/') || relative.startsWith('app/bin/') ? 0o755 : 0o644); } }
await normalize(target);
// normalize marks every app/bin entry executable; the licence stays readable only.
await chmod(path.join(binDir, 'COPYING-dnsmasq'), 0o644);
console.log(`已构建 ${target}（dnsmasq ${runtime.version}，${runtime.arch}）`);
