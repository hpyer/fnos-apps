import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { responsiveShellJS } from '../src/server/shell.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const reason = 'DSH 最低支持版本为 0.1.6，旧版本会话不兼容';

function fixture(initialStatus) {
  const element = () => ({
    hidden: false, disabled: false, textContent: '', title: '', classList: { toggle() {}, remove() {} },
    listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; },
    setAttribute() {}, focus() {},
    click() { if (!this.disabled) return this.listeners.click?.(); },
  });
  const root = element();
  const veil = element();
  const panel = element();
  panel.hidden = true;
  const versions = Object.assign(element(), {
    options: [], value: '', replacements: 0,
    replaceChildren() { this.options = []; this.value = ''; this.replacements += 1; },
    append(option) { this.options.push(option); },
  });
  const nodes = new Map([
    ['[data-role=state-text]', element()], ['[data-action=restart]', element()],
    ['[data-action=menu]', element()], ['[data-role=panel]', panel],
    ['#fnos-dsh-backdrop', element()], ['[data-action=close]', element()], ['[data-role=versions]', versions],
    ['[data-action=apply]', element()], ['[data-action=settings]', element()],
    ['[data-role=note]', element()], ['[data-action=authorize]', element()],
  ]);
  root.querySelector = selector => nodes.get(selector);
  veil.querySelector = () => element();
  const sections = [root, veil];
  const requests = [];
  let poll;
  let status = initialStatus;
  runInNewContext(responsiveShellJS, {
    document: {
      body: { prepend() {}, append() {}, getAttribute() { return ''; } }, hidden: false,
      documentElement: { className: '', getAttribute() { return ''; } },
      createElement: tag => tag === 'section' ? sections.shift() : element(),
    },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => status }; },
    setInterval: callback => { poll = callback; },
    setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
    getComputedStyle: () => ({ colorScheme: 'light' }),
    MutationObserver: class { observe() {} },
    location: { assign() {} },
  });
  return { nodes, panel, versions, requests, poll: () => poll(), setStatus: value => { status = value; } };
}

test('status polling leaves an open supported version selector intact until its options change', async () => {
  let status = { minimumVersion: '0.1.6', current: '0.1.6', running: true, versions: [
    { version: '0.1.6', supported: true, unsupportedReason: null },
    { version: '0.1.7-alpha.2', supported: true, unsupportedReason: null },
  ] };
  const { nodes, panel, versions, poll, setStatus } = fixture(status);
  await settle();
  assert.equal(versions.replacements, 1);
  nodes.get('[data-action=menu]').click();
  versions.value = '0.1.7-alpha.2';
  status = { ...status, activeConnections: 1 };
  setStatus(status);
  poll();
  await settle();
  assert.equal(panel.hidden, false);
  assert.equal(versions.replacements, 1);
  assert.equal(versions.value, '0.1.7-alpha.2');
  status = { ...status, versions: [...status.versions, { version: '0.1.7-rc.1', supported: true, unsupportedReason: null }] };
  setStatus(status);
  poll();
  await settle();
  assert.equal(versions.replacements, 2);
  assert.equal(versions.value, '0.1.7-alpha.2');
  status = { ...status, current: '0.1.7-alpha.2' };
  setStatus(status);
  poll();
  await settle();
  assert.equal(versions.replacements, 3);
  assert.equal(versions.options[1].textContent, '0.1.7-alpha.2 (当前)');
  assert.equal(nodes.get('[data-action=apply]').disabled, true);
});

test('unsupported shell options have disabled labels and reasons and cannot be applied', async () => {
  const { nodes, versions, requests } = fixture({
    minimumVersion: '0.1.6', current: '0.1.6', running: true, versions: [
      { version: '0.1.5', supported: false, unsupportedReason: reason },
      { version: '0.1.6-rc.1', supported: false, unsupportedReason: reason },
      { version: '0.1.6', supported: true, unsupportedReason: null },
      { version: '0.1.7-rc.1', supported: true, unsupportedReason: null },
    ],
  });
  await settle();
  const apply = nodes.get('[data-action=apply]');
  for (const option of versions.options.slice(0, 2)) {
    assert.equal(option.disabled, true);
    assert.equal(option.title, reason);
    assert.equal(option.textContent, `${option.value} (不受支持)`);
    versions.value = option.value;
    versions.listeners.change();
    assert.equal(apply.disabled, true);
    apply.click();
  }
  assert.equal(requests.filter(request => request.options?.method === 'POST').length, 0);
  const supported = versions.options[3];
  assert.equal(supported.disabled, false);
  assert.equal(supported.title, '');
  versions.value = supported.value;
  versions.listeners.change();
  assert.equal(apply.disabled, false);
  versions.value = '0.1.6';
  versions.listeners.change();
  assert.equal(apply.disabled, true);
  versions.value = supported.value;
  versions.listeners.change();
  await apply.click();
  const mutation = requests.find(request => request.options?.method === 'POST');
  assert.equal(mutation.url, '/_fnos/version');
  assert.deepEqual(JSON.parse(mutation.options.body), { version: '0.1.7-rc.1' });
});

test('legacy current shell runtime disables restart but permits switching to a supported runtime', async () => {
  const { nodes, versions, requests } = fixture({
    current: '0.1.5', running: false, versions: [
      { version: '0.1.5', supported: false, unsupportedReason: reason },
      { version: '0.1.6', supported: true, unsupportedReason: null },
    ],
  });
  await settle();
  assert.equal(versions.options[0].textContent, '0.1.5 (当前) (不受支持)');
  assert.equal(nodes.get('[data-action=restart]').disabled, true);
  assert.equal(nodes.get('[data-action=apply]').disabled, true);
  nodes.get('[data-action=restart]').click();
  assert.equal(requests.filter(request => request.options?.method === 'POST').length, 0);
  versions.value = '0.1.6';
  versions.listeners.change();
  assert.equal(nodes.get('[data-action=apply]').disabled, false);
});
