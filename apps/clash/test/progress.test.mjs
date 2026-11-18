import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreparationProgress } from '../src/progress.mjs';

function clock(start = 1000) {
  let value = start;
  return { now: () => value, tick(ms) { value += ms; } };
}

test('按步骤推进并输出快照', () => {
  const time = clock();
  const progress = new PreparationProgress({ now: time.now });
  progress.start('启动内核', [
    { key: 'core', label: '校验内核' },
    { key: 'data', label: '准备外部数据' },
    { key: 'launch', label: '启动内核' },
  ]);
  let snapshot = progress.snapshot();
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.label, '启动内核');
  assert.equal(snapshot.steps.length, 3);
  assert.equal(snapshot.index, -1);

  progress.step('core', '正在校验内核文件');
  progress.step('data', '正在下载 GeoIP 数据库');
  progress.bytes(512, 2048);
  time.tick(3000);
  snapshot = progress.snapshot();
  assert.equal(snapshot.index, 1);
  assert.equal(snapshot.message, '正在下载 GeoIP 数据库');
  assert.equal(snapshot.steps[0].state, 'done');
  assert.equal(snapshot.steps[1].state, 'active');
  assert.equal(snapshot.steps[2].state, 'pending');
  assert.equal(snapshot.received, 512);
  assert.equal(snapshot.bytesTotal, 2048);
  assert.equal(snapshot.elapsedMs, 3000);

  progress.step('launch');
  progress.done();
  snapshot = progress.snapshot();
  assert.equal(snapshot.active, false);
  assert.deepEqual(snapshot.steps.map(step => step.state), ['done', 'done', 'done']);
  assert.equal(snapshot.received, 0);
});

test('未知步骤只更新说明，不会回退已完成的步骤', () => {
  const progress = new PreparationProgress({ now: () => 1000 });
  progress.start('应用配置', [
    { key: 'data', label: '准备外部数据' },
    { key: 'verify', label: '校验配置' },
    { key: 'launch', label: '应用并重启内核' },
  ]);
  progress.step('data');
  progress.step('verify');
  progress.step('core', '正在校验内核'); // not part of this plan
  assert.equal(progress.snapshot().index, 1);
  assert.equal(progress.snapshot().message, '正在校验内核');
  progress.step('data', '不应回退');
  assert.equal(progress.snapshot().index, 1);
  assert.equal(progress.snapshot().steps[0].state, 'done');
  assert.equal(progress.snapshot().message, '不应回退');
  progress.detail('正在保存配置');
  assert.equal(progress.snapshot().message, '正在保存配置');
});

test('失败会标记当前步骤并结束', () => {
  const progress = new PreparationProgress({ now: () => 5000 });
  progress.start('启动内核', [
    { key: 'core', label: '校验内核' },
    { key: 'data', label: '准备外部数据' },
  ]);
  progress.step('data', '正在下载外部数据');
  progress.fail('GeoIP 数据库下载失败');
  const snapshot = progress.snapshot();
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.error, 'GeoIP 数据库下载失败');
  assert.equal(snapshot.steps[0].state, 'done');
  assert.equal(snapshot.steps[1].state, 'error');
  assert.equal(progress.active, false);
});

test('未开始时调用 step/bytes 不产生状态', () => {
  const progress = new PreparationProgress({ now: () => 0 });
  progress.step('data', 'x');
  progress.bytes(10, 20);
  progress.done();
  progress.fail('x');
  const snapshot = progress.snapshot();
  assert.equal(snapshot.active, false);
  assert.deepEqual(snapshot.steps, []);
  assert.equal(snapshot.message, '');
});
