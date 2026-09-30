import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toast } from '../src/index.js';

class Element {
  constructor() { this.children = []; this.listeners = new Map(); this.parent = null; this.attributes = {}; this.textContent = ''; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name, event = {}) { this.listeners.get(name)?.(event); }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  matches(selector) { return selector === ':hover' && this.hovered; }
  get childElementCount() { return this.children.length; }
}

test('toast defaults, hover pause, custom title and manual close', () => {
  const original = { document: globalThis.document, performance: globalThis.performance, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let now = 0, nextId = 0;
  const timers = new Map();
  const body = new Element();
  globalThis.document = { body, activeElement: null, createElement: () => new Element() };
  globalThis.performance = { now: () => now };
  globalThis.setTimeout = (callback, delay) => { const id = ++nextId; timers.set(id, { callback, due: now + delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.callback(); }
  }
  try {
    toast({ type: 'error', content: '<details>copy me</details>' });
    const host = body.children[0], item = host.children[0];
    assert.equal(host.className, 'fnos-toast-host fnos-toast-host--top-right');
    assert.equal(item.attributes.role, 'alert');
    assert.equal(item.children[1].children[0].textContent, '错误');
    assert.equal(item.children[1].children[1].textContent, '<details>copy me</details>');
    advance(1000);
    item.dispatch('mouseenter');
    advance(5000);
    assert.equal(host.childElementCount, 1);
    item.dispatch('mouseleave');
    advance(1999);
    assert.equal(host.childElementCount, 1);
    advance(1);
    assert.equal(body.childElementCount, 0);

    const pending = toast({ type: 'success', title: '已完成', content: '完成', position: 'center', duration: 0 });
    assert.equal(body.children[0].className, 'fnos-toast-host fnos-toast-host--center');
    assert.equal(body.children[0].children[0].children[1].children[0].textContent, '已完成');
    advance(10000);
    assert.equal(body.childElementCount, 1);
    pending.close();
    assert.equal(body.childElementCount, 0);

    const linked = toast({ content: '新版可用', link: { href: 'https://github.com/example/app.fpk', label: '下载 FPK' }, duration: 0 });
    const anchor = body.children[0].children[0].children[1].children[2];
    assert.equal(anchor.href, 'https://github.com/example/app.fpk');
    assert.equal(anchor.textContent, '下载 FPK');
    assert.equal(anchor.rel, 'noopener noreferrer');
    assert.throws(() => toast({ link: { href: 'javascript:alert(1)' } }), /HTTPS/);
    linked.close();

    const warning = toast({ type: 'warning', title: '', content: '注意', position: 'bottom-left' });
    assert.equal(body.children[0].className, 'fnos-toast-host fnos-toast-host--bottom-left');
    assert.equal(body.children[0].children[0].children[1].children[0].textContent, '警告');
    warning.close();
    const info = toast({ content: '普通消息' });
    assert.equal(body.children[0].children[0].children[1].children[0].textContent, '提示');
    info.close();
  } finally {
    Object.assign(globalThis, original);
  }
});
