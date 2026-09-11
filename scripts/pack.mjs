import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseCli, resolveApp, root } from './app-config.mjs';

const { options, positional } = parseCli(process.argv.slice(2));
const app = await resolveApp(options.app || positional[0]);
const architectures = options.all ? app.supportedArchitectures : [options.arch || 'x86'];
const invalid = architectures.filter((arch) => !['x86', 'arm'].includes(arch));
if (invalid.length) throw new Error(`不支持的架构：${invalid.join(', ')}；可选 x86 或 arm`);

const version = options.version || app.version;
if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) throw new Error(`版本号格式无效：${version}`);
const outputDir = path.resolve(options.output || path.join(root, 'dist', 'release'));
await mkdir(outputDir, { recursive: true });
await stat(app.distDir).catch(() => { throw new Error(`请先构建应用：${app.distDir}`); });

function patchManifest(source, targetVersion, platform) {
  if (!/^\s*version\s*=/m.test(source) || !/^\s*platform\s*=/m.test(source)) {
    throw new Error('manifest 必须包含 version 和 platform 字段');
  }
  return source
    .replace(/^\s*version\s*=\s*.*$/m, `version = ${targetVersion}`)
    .replace(/^\s*platform\s*=\s*.*$/m, `platform = ${platform}`);
}

async function findFpk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('.fpk')) {
      files.push({ path: entryPath, mtimeMs: (await stat(entryPath)).mtimeMs });
    } else if (entry.isDirectory()) {
      files.push(...await findFpk(entryPath));
    }
  }
  return files;
}

for (const arch of architectures) {
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), `fnos-${app.slug}-${arch}-`));
  const staging = path.join(stagingRoot, app.appId);
  try {
    await cp(app.distDir, staging, { recursive: true, dereference: true });
    const manifestPath = path.join(staging, 'manifest');
    await writeFile(manifestPath, patchManifest(await readFile(manifestPath, 'utf8'), version, arch));
    const fnpack = process.env.FNPACK_BIN || 'fnpack';
    const result = spawnSync(fnpack, ['build', '--directory', staging], { cwd: stagingRoot, stdio: 'inherit' });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) throw new Error(`fnpack 构建失败（${arch}）`);
    const candidates = await findFpk(stagingRoot);
    if (!candidates.length) throw new Error(`fnpack 没有生成新的 FPK 文件（${arch}）`);
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const target = path.join(outputDir, `${app.filePrefix}_v${version}_${arch}.fpk`);
    await rm(target, { force: true });
    await rename(candidates[0].path, target);
    console.log(`已打包 ${target}`);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
