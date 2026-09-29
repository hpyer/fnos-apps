import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./', import.meta.url));
const target = path.resolve(source, '../../dist/nginx-for-fnos');
await rm(target, { recursive: true, force: true });
await cp(path.join(source, 'native'), target, { recursive: true });
await mkdir(path.join(target, 'app'), { recursive: true });
await cp(path.join(source, 'src'), path.join(target, 'app'), { recursive: true });
await build({
  entryPoints: [path.join(source, 'src/web/index.js'), path.join(source, 'src/web/index.css')],
  outdir: path.join(target, 'app/web'),
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
});
console.log(`已构建 ${target}`);
