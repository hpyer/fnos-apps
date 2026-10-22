import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobFeedback } from '../src/web/job-feedback.mjs';

function fixture() {
  const messages = [];
  const report = createJobFeedback(options => {
    const message = { ...options, closed: false };
    messages.push(message);
    return { close: () => { message.closed = true; } };
  });
  return { report, messages };
}
const running = { state: 'running', action: 'install', id: 'one', message: '下载中' };
const success = { ...running, state: 'success', message: '下载与自检完成，请在已安装版本中启用' };

test('轮询只提示一次完成消息，相同操作再次执行仍会提示', () => {
  const { report, messages } = fixture();
  report({ state: 'idle' }); report(running); report(success);
  for (let i = 0; i < 5; i++) report({ ...success });
  assert.equal(messages.length, 1); assert.equal(messages[0].type, 'success');
  report(running); assert.equal(messages[0].closed, true);
  report(success); assert.equal(messages.length, 2);
});
test('打开页面不重放历史成功，历史错误和新错误保留到手动关闭', () => {
  const { report, messages } = fixture();
  report(success); assert.equal(messages.length, 0);
  report(running);
  const failure = { ...running, state: 'error', message: 'SHA256 不匹配' };
  report(failure); report(failure);
  assert.equal(messages.length, 1); assert.equal(messages[0].duration, 0);
  assert.equal(messages[0].content, 'SHA256 不匹配');
  const initial = fixture(); initial.report(failure);
  assert.equal(initial.messages[0].type, 'error'); assert.equal(initial.messages[0].duration, 0);
});
