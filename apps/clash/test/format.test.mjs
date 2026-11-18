import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  configKindLabel, connectionTarget, delayLevel, delayText, formatBytes, formatClock,
  formatDuration, modeLabel, levelLabel, truncate,
} from '../src/web/format.mjs';

test('字节与速率格式化', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.00 KiB');
  assert.equal(formatBytes(1536), '1.50 KiB');
  assert.equal(formatBytes(1024 * 1024, { rate: true }), '1.00 MiB/s');
  assert.equal(formatBytes(1024 * 1024 * 1024 * 2.5), '2.50 GiB');
});

test('时长格式化覆盖秒、分、时、天', () => {
  assert.equal(formatDuration(45000), '45 秒');
  assert.equal(formatDuration(90000), '1 分 30 秒');
  assert.equal(formatDuration(3_900_000), '1 小时 5 分');
  assert.equal(formatDuration(90_000_000), '1 天 1 小时');
  assert.equal(formatDuration(-5), '0 秒');
});

test('延迟等级、模式、级别与连接目标', () => {
  assert.equal(delayLevel(0), 'none');
  assert.equal(delayLevel(120), 'good');
  assert.equal(delayLevel(500), 'warn');
  assert.equal(delayLevel(1200), 'bad');
  assert.equal(delayText(120), '120 ms');
  assert.equal(delayText(0), '—');
  assert.equal(modeLabel('rule'), '规则');
  assert.equal(modeLabel('global'), '全局');
  assert.equal(modeLabel('direct'), '直连');
  assert.equal(levelLabel('warning'), '警告');
  assert.equal(configKindLabel('subscription'), '订阅应用');
  assert.equal(connectionTarget({ host: 'example.com', port: '443' }), 'example.com:443');
  assert.equal(connectionTarget({ destination: '1.2.3.4' }), '1.2.3.4');
  assert.equal(connectionTarget(null), '—');
});

test('时间、截断与时钟', () => {
  const value = new Date(2026, 0, 2, 3, 4, 5).toISOString();
  assert.equal(formatClock(value), '03:04:05');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
  assert.equal(truncate(null, 4), '');
});
