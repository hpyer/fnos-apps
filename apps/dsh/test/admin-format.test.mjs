import test from 'node:test';
import assert from 'node:assert/strict';
import { elapsedLabel } from '../src/web/admin/format.mjs';

test('download elapsed time switches from seconds to minutes and seconds', () => {
  assert.equal(elapsedLabel(0), '0 秒');
  assert.equal(elapsedLabel(59), '59 秒');
  assert.equal(elapsedLabel(60), '1 分 0 秒');
  assert.equal(elapsedLabel(125.9), '2 分 5 秒');
});
