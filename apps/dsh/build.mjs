import { build } from 'esbuild';
import { cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = fileURLToPath(new URL('./', import.meta.url));
const target = path.join(root, 'dist/dsh-for-fnos');

// The native skeleton owns manifest, commands and desktop assets. Source files
// below are mapped back to the stable app/ paths expected by those commands.
await rm(target, { recursive: true, force: true });
await cp(path.join(source, 'native'), target, { recursive: true });
for (const name of ['main', 'setup']) {
  await build({ entryPoints: [path.join(source, `src/app/${name}.mjs`)], outfile: path.join(target, `app/${name}.mjs`), bundle: true, platform: 'node', target: 'node24', format: 'esm' });
}
for (const [sourceFile, outputFile] of [['web/host/host-bridge.mjs', 'host-bridge.js'], ['web/launcher/launcher-bridge.mjs', 'launcher-bridge.js']]) {
  await build({ entryPoints: [path.join(source, `src/${sourceFile}`)], outfile: path.join(target, `app/${outputFile}`), bundle: true, platform: 'browser', target: 'es2022', format: 'iife' });
}
for (const [sourceFile, outputFile] of [['web/admin/index.js', 'admin.js'], ['web/launcher/index.js', 'launcher.js']]) {
  // Both browser entry points use the fnOS Web SDK. Bundle them so the native
  // WebView never has to resolve workspace-only bare package specifiers.
  await build({ entryPoints: [path.join(source, 'src', sourceFile)], outfile: path.join(target, 'app', outputFile), bundle: true, platform: 'browser', target: 'es2022', format: 'esm' });
}
for (const [sourceFile, outputFile] of [
  ['runtime/worker.mjs', 'worker.mjs'],
  ['web/host/subpath.js', 'subpath.js'],
  ['web/admin/index.html', 'admin.html'], ['web/admin/index.css', 'admin.css'],
  ['web/launcher/index.html', 'launcher.html'], ['web/launcher/index.css', 'launcher.css'],
  ['shared/icons.mjs', 'icons.mjs'],
]) {
  await cp(path.join(source, 'src', sourceFile), path.join(target, 'app', outputFile));
}
// pnpm is bundled for isolated runtime installation; fnOS still supplies Node.
await cp(await realpath(path.join(root, 'node_modules/pnpm')), path.join(target, 'app/tools/pnpm'), { recursive: true });
await mkdir(path.join(target, 'app/licenses'), { recursive: true });
await cp(path.join(await realpath(path.join(source, 'node_modules/semver')), 'LICENSE'), path.join(target, 'app/licenses/semver-LICENSE'));
await mkdir(path.join(target, 'app/tools/bin'), { recursive: true });
await writeFile(path.join(target, 'app/tools/bin/pnpm'), '#!/bin/sh\nexec node "$(dirname "$0")/../pnpm/bin/pnpm.cjs" "$@"\n', { mode: 0o755 });
console.log(`已构建 ${target}`);
