import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cmdDir = fileURLToPath(new URL('../native/cmd/', import.meta.url));

// fnOS unpacks the FPK payload at the target root, so the installed layout is
// `target/cores/<arch>/mihomo.gz` while `app/cores/...` only exists in the build
// directory. Lifecycle scripts must use the installed layout.
async function installedTarget(t, { arches = ['x86_64'] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clash-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const arch of arches) {
    await mkdir(path.join(root, 'cores', arch), { recursive: true });
    await writeFile(path.join(root, 'cores', arch, 'mihomo.gz'), 'core');
  }
  await writeFile(path.join(root, 'main.mjs'), '// manager entry\n');
  return root;
}

function run(script, target) {
  return spawnSync('/bin/sh', [path.join(cmdDir, script)], {
    env: { PATH: process.env.PATH, TRIM_APPDEST: target, TRIM_PKGVAR: path.join(target, 'var') },
    encoding: 'utf8',
  });
}

test('单架构 FPK 的安装布局可以直接升级', async t => {
  const target = await installedTarget(t, { arches: ['x86_64'] });
  const result = run('upgrade_init', target);
  assert.equal(result.status, 0, result.stderr);
});

test('ARM64 FPK 同样按安装布局通过升级检查', async t => {
  const target = await installedTarget(t, { arches: ['arm64'] });
  const result = run('upgrade_init', target);
  assert.equal(result.status, 0, result.stderr);
});

test('升级前拿不到新包内容时不阻断升级', async t => {
  // upgrade_init runs before fnOS unpacks the new payload, so it must never fail
  // on missing files; a broken package is reported by the manager on start.
  const root = await mkdtemp(path.join(os.tmpdir(), 'clash-lifecycle-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = run('upgrade_init', root);
  assert.equal(result.status, 0, result.stderr);
});

test('install_init 不依赖构建目录布局', async t => {
  const target = await installedTarget(t, { arches: ['x86_64'] });
  const result = run('install_init', target);
  assert.equal(result.status, 0, result.stderr);
});

test('生命周期脚本不引用构建目录的 app/ 前缀', async () => {
  for (const script of ['install_init', 'install_callback', 'upgrade_init', 'upgrade_callback', 'main', 'uninstall_init', 'uninstall_callback']) {
    const source = await readFile(path.join(cmdDir, script), 'utf8');
    assert.doesNotMatch(source, /TRIM_APPDEST\}"?\/app\//, `${script} 使用了构建目录布局`);
  }
});
