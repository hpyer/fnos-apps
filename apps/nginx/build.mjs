import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./', import.meta.url));
const target = path.resolve(source, '../../dist/nginx-for-fnos');
await rm(target, { recursive: true, force: true });
await cp(path.join(source, 'native'), target, { recursive: true });
await mkdir(path.join(target, 'app'), { recursive: true });
const appVersion = /^version\s*=\s*(\d+\.\d+\.\d+)\s*$/m.exec(await readFile(path.join(source, 'native/manifest'), 'utf8'))?.[1];
if (!appVersion) throw new Error('manifest 缺少有效版本号');
await writeFile(path.join(target, 'app/version'), `version = ${appVersion}\n`);
await cp(path.join(source, 'src'), path.join(target, 'app'), { recursive: true });
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
});
console.log(`已构建 ${target}`);
