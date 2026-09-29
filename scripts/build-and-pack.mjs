import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCli, resolveApp } from './app-config.mjs';

const args = process.argv.slice(2);
const { options, positional } = parseCli(args);
const app = await resolveApp(options.app || positional[0]);
const versionRequested = args.some(arg => arg === '--version' || arg.startsWith('--version='));

function buildAndPack() {
  for (const script of ['build-app.mjs', 'pack.mjs']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
  }
}

if (!versionRequested) {
  buildAndPack();
} else {
  const version = options.version;
  if (version === undefined) throw new Error('--version 缺少版本号');
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) throw new Error(`版本号格式无效：${version}`);

  const packagePath = path.join(app.dir, 'package.json');
  const [originalPackage, originalManifest] = await Promise.all([
    readFile(packagePath, 'utf8'),
    readFile(app.manifestPath, 'utf8'),
  ]);
  if (!/^\s*version\s*=/m.test(originalManifest)) throw new Error(`应用 ${app.slug} 的 manifest 缺少 version 字段`);

  try {
    await writeFile(packagePath, `${JSON.stringify({ ...app.packageJson, version }, null, 2)}\n`);
    await writeFile(app.manifestPath, originalManifest.replace(/^\s*version\s*=.*$/m, `version = ${version}`));
    buildAndPack();
  } finally {
    await Promise.all([
      writeFile(packagePath, originalPackage),
      writeFile(app.manifestPath, originalManifest),
    ]);
  }
}
