import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogAction } from '../src/catalog-action.mjs';

test('全局入口透传参数、标准输入和退出码，不解释 shell 元字符', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = path.join(root, 'versions/one');
  await mkdir(path.join(version, 'bin'), { recursive: true }); await writeFile(path.join(version, '.use.lock'), '');
  await writeFile(path.join(root, 'catalog.lock'), ''); await symlink('versions/one', path.join(root, 'current'));
  const binary = path.join(version, 'bin/ffmpeg');
  await writeFile(binary, '#!/bin/bash\nprintf "%s\\n" "$@"\ncat\nexit 7\n'); await chmod(binary, 0o755);
  const wrapper = path.join(root, 'ffmpeg');
  await writeFile(wrapper, (await readFile(new URL('../native/app/bin/ffmpeg', import.meta.url), 'utf8')).replace('ROOT=/var/apps/ffmpeg-for-fnos/var', `ROOT=${root}`));
  await chmod(wrapper, 0o755);
  let env = process.env;
  if (process.platform !== 'linux') {
    // macOS has no util-linux flock. Argument/stdio tests use a no-op lock; real locking is tested below on Linux CI.
    const tools = path.join(root, 'tools'); await mkdir(tools); await writeFile(path.join(tools, 'flock'), '#!/bin/sh\nexit 0\n'); await chmod(path.join(tools, 'flock'), 0o755);
    env = { ...process.env, PATH: tools + ':' + process.env.PATH };
  }
  const result = spawnSync(wrapper, ['space argument', '$(touch sentinel)', '; echo injected', '-i', '-'], { encoding: 'utf8', input: 'stdin content\n', env });
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.stdout, 'space argument\n$(touch sentinel)\n; echo injected\n-i\n-\nstdin content\n');
  const probe = path.join(root, 'ffprobe');
  await writeFile(probe, (await readFile(new URL('../native/app/bin/ffprobe', import.meta.url), 'utf8')).replace('ROOT=/var/apps/ffmpeg-for-fnos/var', `ROOT=${root}`));
  await chmod(probe, 0o755);
  const missing = spawnSync(probe, ['-version'], { encoding: 'utf8', env });
  assert.equal(missing.status, 127); assert.match(missing.stderr, /当前版本未安装 ffprobe/);
});
test('Linux: 长任务保持旧版本锁，原子切换后新任务使用新版本', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-locks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'catalog.lock'), '');
  for (const id of ['one', 'two']) {
    const directory = path.join(root, 'versions', id); await mkdir(path.join(directory, 'bin'), { recursive: true });
    await writeFile(path.join(directory, '.use.lock'), ''); await writeFile(path.join(directory, 'metadata.json'), JSON.stringify({ id }));
    await writeFile(path.join(directory, 'bin/ffmpeg'), `#!/bin/bash\nprintf '${id}\\n'\nif [ "\$1" = hold ]; then read -r line; fi\n`);
    await chmod(path.join(directory, 'bin/ffmpeg'), 0o755);
  }
  await catalogAction(root, 'activate', 'one');
  const wrapper = path.join(root, 'ffmpeg');
  await writeFile(wrapper, (await readFile(new URL('../native/app/bin/ffmpeg', import.meta.url), 'utf8')).replace('ROOT=/var/apps/ffmpeg-for-fnos/var', `ROOT=${root}`)); await chmod(wrapper, 0o755);
  const child = spawn(wrapper, ['hold'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const completed = new Promise(resolve => child.once('close', resolve));
  await new Promise((resolve, reject) => { child.stdout.once('data', value => { assert.match(value.toString(), /one/); resolve(); }); child.once('error', reject); });
  // The catalog lock is released after acquiring the version lock: switching does not block.
  const helper = fileURLToPath(new URL('../src/catalog-action.mjs', import.meta.url));
  const switched = spawnSync('/usr/bin/flock', ['-w', '2', '-x', path.join(root, 'catalog.lock'), process.execPath, helper, root, 'activate', 'two'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(switched.status, 0, switched.stderr);
  assert.equal(spawnSync(wrapper, [], { encoding: 'utf8' }).stdout, 'two\n');
  await assert.rejects(catalogAction(root, 'remove', 'one'), /仍有命令在运行/);
  child.stdin.end('finish\n'); await completed;
  await catalogAction(root, 'remove', 'one');
  assert.deepEqual(await readdir(path.join(root, 'versions')), ['two']);
});
