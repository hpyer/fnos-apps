import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { responsiveShellJS } from '../src/server/shell.mjs';

test('status polling leaves an open version selector intact until its options change', async () => {
  const element = () => ({
    hidden: false, disabled: false, textContent: '', classList: { toggle() {} },
    listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; },
    setAttribute() {}, focus() {},
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
  let poll;
  let status = { current: '0.1.6-alpha.2', running: true, versions: [
    { version: '0.1.6-alpha.2' }, { version: '0.1.7-alpha.2' },
  ] };
  runInNewContext(responsiveShellJS, {
    document: {
      body: { prepend() {}, append() {}, getAttribute() { return ''; } }, hidden: false,
      documentElement: { className: '', getAttribute() { return ''; } },
      createElement: tag => tag === 'section' ? sections.shift() : element(),
    },
    fetch: async () => ({ ok: true, json: async () => status }),
    setInterval: callback => { poll = callback; },
    setTimeout: () => 1, clearTimeout() {}, addEventListener() {},
    getComputedStyle: () => ({ colorScheme: 'light' }),
    MutationObserver: class { observe() {} },
    location: { assign() {} },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  assert.equal(versions.replacements, 1);
  nodes.get('[data-action=menu]').listeners.click();
  versions.value = '0.1.7-alpha.2';
  status = { ...status, activeConnections: 1 };
  poll();
  await settle();
  assert.equal(panel.hidden, false);
  assert.equal(versions.replacements, 1);
  assert.equal(versions.value, '0.1.7-alpha.2');
  status = { ...status, versions: [...status.versions, { version: '0.1.7-rc.1' }] };
  poll();
  await settle();
  assert.equal(versions.replacements, 2);
  assert.equal(versions.value, '0.1.7-alpha.2');
  status = { ...status, current: '0.1.7-alpha.2' };
  poll();
  await settle();
  assert.equal(versions.replacements, 3);
  assert.equal(versions.options[1].textContent, '0.1.7-alpha.2 (当前)');
  assert.equal(nodes.get('[data-action=apply]').disabled, true);
});
