import { build } from 'esbuild';
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureEmbeddedCores } from './scripts/cores.mjs';

const source = fileURLToPath(new URL('./', import.meta.url));
const target = path.resolve(source, '../../dist/clash-for-fnos');

const appVersion = /^version\s*=\s*(\d+\.\d+\.\d+)\s*$/m.exec(await readFile(path.join(source, 'native/manifest'), 'utf8'))?.[1];
if (!appVersion) throw new Error('manifest 缺少有效版本号');
const cores = await ensureEmbeddedCores({ includeGeodata: false });

await rm(target, { recursive: true, force: true });
await cp(path.join(source, 'native'), target, { recursive: true });
await mkdir(path.join(target, 'app'), { recursive: true });
await writeFile(path.join(target, 'app/version'), `version = ${appVersion}\n`);
await cp(path.join(source, 'src'), path.join(target, 'app'), { recursive: true });

const coreRoot = path.join(target, 'app/cores');
await mkdir(coreRoot, { recursive: true });
for (const arch of ['x86_64', 'arm64']) {
  await mkdir(path.join(coreRoot, arch), { recursive: true });
  await cp(cores.files[arch], path.join(coreRoot, arch, 'mihomo.gz'));
  await chmod(path.join(coreRoot, arch, 'mihomo.gz'), 0o444);
}
await cp(cores.licenseFile, path.join(coreRoot, 'LICENSE-mihomo.txt'));
await chmod(path.join(coreRoot, 'LICENSE-mihomo.txt'), 0o444);
const { geodata: _geodata, ...coreLock } = cores.lock;
await writeFile(path.join(coreRoot, 'core-versions.json'), JSON.stringify({ ...coreLock, bundledAt: new Date().toISOString() }, null, 2) + '\n');

const versionCheckPackage = path.join(target, 'app/node_modules/@fnos/version-check');
await mkdir(path.join(versionCheckPackage, 'src'), { recursive: true });
await cp(path.join(source, '../../packages/version-check/package.json'), path.join(versionCheckPackage, 'package.json'));
await cp(path.join(source, '../../packages/version-check/src/check.mjs'), path.join(versionCheckPackage, 'src/check.mjs'));
await cp(path.join(source, '../../packages/version-check/src/core.mjs'), path.join(versionCheckPackage, 'src/core.mjs'));

await build({
  entryPoints: [path.join(source, 'src/web/index.js'), path.join(source, 'src/web/index.css')],
  outdir: path.join(target, 'app/web'),
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  logLevel: 'warning',
});
// The repository may be checked out with restrictive umasks; FPK files must be
// readable by the application user and lifecycle scripts must stay executable.
async function normalizePermissions(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const relative = path.relative(target, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      await chmod(full, 0o755);
      await normalizePermissions(full);
    } else if (entry.isFile()) {
      if (relative.startsWith('cmd/') || relative.startsWith('app/bin/')) await chmod(full, 0o755);
      else if (relative.startsWith('app/cores/') && relative.endsWith('.gz')) await chmod(full, 0o444);
      else if (relative.startsWith('app/cores/geo/')) await chmod(full, 0o444);
      else if (relative.startsWith('app/cores/LICENSE')) await chmod(full, 0o444);
      else await chmod(full, 0o644);
    }
  }
}
await normalizePermissions(target);
console.log(`已构建 ${target}（mihomo ${cores.lock.version}，x86_64 + arm64）`);
