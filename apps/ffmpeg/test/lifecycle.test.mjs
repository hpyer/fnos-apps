import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('安装和升级拒绝占用的命令，保留文件内容，接受本应用链接', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ffmpeg-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const global = path.join(root, 'global'), app = path.join(root, 'app');
  await mkdir(global); await mkdir(path.join(app, 'bin'), { recursive: true });
  const tool = path.join(root, 'dependency'); await writeFile(tool, '#!/bin/sh\nexit 0\n'); await chmod(tool, 0o755);
  const env = { ...process.env, TRIM_APPDEST: app, TRIM_TEMP_LOGFILE: path.join(root, 'error') };
  for (const name of ['install_init', 'upgrade_init']) {
    const source = (await readFile(new URL(`../native/cmd/${name}`, import.meta.url), 'utf8')).replace('/usr/local/bin/', global + '/').replaceAll('/usr/bin/xz', tool).replaceAll('/usr/bin/flock', tool);
    const file = path.join(root, name); await writeFile(file, source);
    const run = () => spawnSync('/bin/bash', [file], { env, encoding: 'utf8' });
    const command = path.join(global, 'ffmpeg');
    assert.equal(run().status, 0);
    await writeFile(command, 'keep this file');
    assert.equal(run().status, 1); assert.equal(await readFile(command, 'utf8'), 'keep this file');
    assert.match(await readFile(env.TRIM_TEMP_LOGFILE, 'utf8'), /命令冲突/);
    await rm(command); await symlink('/some/other/package/ffmpeg', command);
    assert.equal(run().status, 1);
    await rm(command); await symlink(path.join(app, 'bin/ffmpeg'), command);
    assert.equal(run().status, 0);
    await rm(command);
  }
});
