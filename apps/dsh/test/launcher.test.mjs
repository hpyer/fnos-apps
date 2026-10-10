import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/web/launcher/index.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/web/launcher/index.html', import.meta.url), 'utf8');
const executable = source.replace(/^import \{ TrimApp \} from '@trimjs\/web-app';\r?\n/m, '');
const settle = () => new Promise(resolve => setImmediate(resolve));
const reason = 'DSH 最低支持版本为 0.1.6，旧版本会话不兼容';
const base = '/app/dsh-for-fnos';

function legacyStatus(overrides = {}) {
  return {
    minimumVersion: '0.1.6', current: '0.1.5', running: false, busy: null,
    isAdmin: false, needsHomeAuthorization: false,
    versions: [
      { version: '0.1.5', supported: false, unsupportedReason: reason },
      { version: '0.1.6-rc.1', supported: false, unsupportedReason: reason },
      { version: '0.1.6', supported: true, unsupportedReason: null },
      { version: '0.1.6+build', supported: true, unsupportedReason: null },
      { version: '0.1.7-rc.1', supported: true, unsupportedReason: null },
    ],
    ...overrides,
  };
}

function fixture(initialStatus) {
  const element = () => ({
    hidden: false, disabled: false, textContent: '', value: '', options: [], listeners: {},
    addEventListener(event, callback) { this.listeners[event] = callback; },
    replaceChildren() { this.options = []; this.value = ''; },
    append(option) { this.options.push(option); if (!this.value) this.value = option.value; },
    click() { if (!this.hidden && !this.disabled) return this.listeners.click?.(); },
  });
  const nodes = new Map();
  for (const match of html.matchAll(/<(?:button|select|a|h1|p)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    nodes.set(match[1], Object.assign(element(), { hidden: /\bhidden\b/.test(match[0]) }));
  }
  const requests = [];
  const navigations = [];
  const timers = [];
  let status = initialStatus;
  let activate;
  runInNewContext(executable, {
    document: { getElementById: id => nodes.get(id), createElement: () => element() },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === `${base}/api/status`) return { ok: true, json: async () => status };
      if (url === `${base}/api/activate`) {
        if (activate) await activate();
        return { ok: true, json: async () => ({}) };
      }
      if (url === `${base}/api/launch`) return { ok: true, json: async () => ({ url: '/safe-dsh-session' }) };
      assert.fail(`unexpected launcher request: ${url}`);
    },
    setTimeout: (callback, milliseconds) => { timers.push({ callback, milliseconds }); return timers.length; },
    location: { replace: url => navigations.push(url) },
  });
  return {
    nodes, requests, navigations,
    setStatus: value => { status = value; },
    setActivate: callback => { activate = callback; },
    async poll() {
      assert.ok(timers.length, 'launcher should schedule another status check');
      await timers.shift().callback();
      await settle();
    },
  };
}

test('legacy launcher shows supported recovery for an ordinary user without automatic start or settings access', async () => {
  const view = fixture(legacyStatus());
  await settle();
  assert.equal(view.nodes.get('title').textContent, '当前 DSH 版本不受支持');
  assert.ok(view.nodes.get('message').textContent.includes(reason));
  assert.equal(view.nodes.get('authorize-home').hidden, true);
  assert.equal(view.nodes.get('open-settings').hidden, true);
  const select = view.nodes.get('supported-version');
  const button = view.nodes.get('switch-version');
  assert.equal(select.hidden, false);
  assert.equal(button.hidden, false);
  assert.equal(select.disabled, false);
  assert.equal(button.disabled, false);
  assert.deepEqual(select.options.map(option => option.value), ['0.1.6', '0.1.6+build', '0.1.7-rc.1']);
  select.value = '0.1.7-rc.1';
  await view.poll();
  assert.equal(select.value, '0.1.7-rc.1');
  assert.equal(view.requests.filter(request => request.options.method === 'POST').length, 0);
  assert.deepEqual(view.navigations, []);

  let release;
  view.setActivate(() => new Promise(resolve => { release = resolve; }));
  const pending = button.click();
  assert.equal(button.disabled, true);
  const activation = view.requests.find(request => request.url.endsWith('/activate'));
  assert.equal(activation.options.method, 'POST');
  assert.equal(activation.options.headers['x-fnos-request'], '1');
  assert.deepEqual(JSON.parse(activation.options.body), { version: '0.1.7-rc.1' });
  button.click();
  assert.equal(view.requests.filter(request => request.url.endsWith('/activate')).length, 1);
  release();
  await pending;
  assert.equal(button.disabled, false);
  view.setStatus(legacyStatus({ current: '0.1.7-rc.1', running: true }));
  await view.poll();
  assert.equal(select.hidden, true);
  assert.equal(button.hidden, true);
  assert.equal(view.nodes.get('open-settings').hidden, true);
  assert.equal(view.requests.some(request => request.url.endsWith('/start')), false);
  const launch = view.requests.find(request => request.url.endsWith('/launch'));
  assert.equal(launch.options.method, 'POST');
  assert.deepEqual(JSON.parse(launch.options.body), {});
  assert.deepEqual(view.navigations, ['/safe-dsh-session']);
});

test('legacy launcher without a compatible installed runtime directs ordinary users to the administrator', async () => {
  const view = fixture(legacyStatus({ versions: legacyStatus().versions.slice(0, 2) }));
  await settle();
  assert.equal(view.nodes.get('title').textContent, '当前 DSH 版本不受支持');
  assert.match(view.nodes.get('message').textContent, /联系管理员下载/);
  assert.equal(view.nodes.get('supported-version').hidden, true);
  assert.equal(view.nodes.get('supported-version').options.length, 0);
  assert.equal(view.nodes.get('switch-version').hidden, true);
  assert.equal(view.nodes.get('open-settings').hidden, true);
  await view.poll();
  view.nodes.get('switch-version').click();
  assert.equal(view.requests.filter(request => request.options.method === 'POST').length, 0);
  assert.deepEqual(view.navigations, []);
});

test('administrator legacy recovery retains the settings link and disables switching while busy', async () => {
  const view = fixture(legacyStatus({ isAdmin: true, busy: '切换版本' }));
  await settle();
  assert.equal(view.nodes.get('open-settings').hidden, false);
  assert.match(html, /id="open-settings" href="\.\/settings\/"/);
  assert.match(view.nodes.get('message').textContent, /打开设置下载受支持版本/);
  assert.equal(view.nodes.get('supported-version').hidden, false);
  assert.equal(view.nodes.get('switch-version').hidden, false);
  assert.equal(view.nodes.get('supported-version').disabled, true);
  assert.equal(view.nodes.get('switch-version').disabled, true);
  view.nodes.get('switch-version').click();
  assert.equal(view.requests.filter(request => request.options.method === 'POST').length, 0);
  view.setStatus(legacyStatus({ isAdmin: true, versions: legacyStatus().versions.slice(0, 2) }));
  await view.poll();
  assert.equal(view.nodes.get('open-settings').hidden, false);
  assert.equal(view.nodes.get('supported-version').hidden, true);
  assert.equal(view.nodes.get('switch-version').hidden, true);
  assert.equal(view.requests.filter(request => request.options.method === 'POST').length, 0);
  assert.deepEqual(view.navigations, []);
});
