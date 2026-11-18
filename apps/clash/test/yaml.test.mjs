import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/errors.mjs';
import { configInfo, ensureTunDns, injectController, proxyProviders, setTunEnabled, setTopLevel, topLevelValue, validateConfigSource } from '../src/yaml.mjs';

const SOURCE = `# my config
mixed-port: 7890
port: 7891
socks-port: 7892
allow-lan: true
mode: rule
log-level: debug
external-controller: 0.0.0.0:9090
external-controller-cors:
  allow-origins:
    - '*'
secret: "old-secret"
proxies: []
proxy-groups: []
rules:
  - MATCH,DIRECT
`;

test('读取 proxy-providers 并忽略 external-ui', () => {
  const source = [
    'mixed-port: 7890',
    'external-ui: /tmp/ui',
    'external-ui-url: "https://example.com/ui.zip"',
    'proxy-providers:',
    '  airport:',
    '    type: http',
    '    url: https://example.com/sub',
    '    interval: 3600',
    '  backup:',
    '    type: file',
    '    path: ./backup.yaml',
    '',
  ].join('\n');
  assert.deepEqual(proxyProviders(source), [
    { name: 'airport', type: 'http', interval: 3600 },
    { name: 'backup', type: 'file', interval: 0 },
  ]);
  const result = injectController(source, { socketPath: '/tmp/c.sock', secret: 's', logLevel: 'info' });
  assert.doesNotMatch(result, /external-ui/);
  assert.match(result, /external-controller-unix/);
});

test('按设置覆盖端口与 allow-lan', () => {
  const result = injectController('mixed-port: 7890\nport: 7891\nallow-lan: false\n', {
    socketPath: '/tmp/c.sock', secret: 's', logLevel: 'info',
    network: { ports: { mixed: 7899, http: 0, socks: 1080 }, allowLan: true },
  });
  assert.match(result, /mixed-port: 7899/);
  assert.doesNotMatch(result, /^port: 7891$/m);
  assert.match(result, /socks-port: 1080/);
  assert.match(result, /allow-lan: true/);
});

test('注入托管 Controller 并移除对外暴露的旧字段', () => {
  const result = injectController(SOURCE, { socketPath: '/tmp/runtime/controller.sock', secret: 'new-secret', logLevel: 'info' });
  assert.match(result, /external-controller-unix: \/?tmp\/runtime\/controller.sock/);
  assert.match(result, /secret: new-secret/);
  assert.match(result, /log-level: info/);
  assert.doesNotMatch(result, /0\.0\.0\.0:9090/);
  assert.doesNotMatch(result, /old-secret/);
  assert.doesNotMatch(result, /allow-origins/);
  assert.equal((result.match(/^secret:/gm) || []).length, 1);
  assert.equal((result.match(/^log-level:/gm) || []).length, 1, '托管日志级别不能与用户配置重复');
  assert.match(result, /mixed-port: 7890/);
  assert.match(result, /- MATCH,DIRECT/);
});

test('JSON 配置同样注入并保留其他字段', () => {
  const source = JSON.stringify({ 'mixed-port': 7890, mode: 'rule', secret: 'old', 'external-controller': '0.0.0.0:9090', proxies: [] });
  const result = injectController(source, { socketPath: '/run/c.sock', secret: 's', logLevel: 'warning' });
  const value = JSON.parse(result);
  assert.equal(value['external-controller-unix'], '/run/c.sock');
  assert.equal(value.secret, 's');
  assert.equal(value['log-level'], 'warning');
  assert.equal(value['external-controller'], undefined);
  assert.ok(Array.isArray(value.proxies));
});

test('开关 TUN 时保留其他配置和已有字段', () => {
  const base = 'mixed-port: 7890\ntun:\n  stack: system\n  auto-route: true\n  enable: false\nrules:\n  - MATCH,DIRECT\n';
  const enabled = setTunEnabled(base, true);
  assert.match(enabled, /^  enable: true$/m);
  assert.equal((enabled.match(/^  enable:/gm) || []).length, 1);
  assert.match(enabled, /^  stack: system$/m);
  assert.match(enabled, /^mixed-port: 7890$/m);
  assert.equal(configInfo(enabled).tunEnabled, true);
  const disabled = setTunEnabled(enabled, false);
  assert.equal(configInfo(disabled).tunEnabled, false);
  const fresh = setTunEnabled('mixed-port: 7890\n', true);
  assert.match(fresh, /^tun:$/m);
  assert.match(fresh, /dns-hijack:/);
  assert.equal(configInfo(fresh).tunEnabled, true);
  assert.equal(configInfo('tun:\n  enable: true\n  device: Meta\n').tunDevice, 'Meta');
  assert.equal(configInfo(setTunEnabled(JSON.stringify({ 'mixed-port': 7890 }), true)).tunEnabled, true);
  const pinned = setTunEnabled(base, true, { interfaceName: 'enp0s5' });
  assert.match(pinned, /^  auto-detect-interface: false$/m);
  assert.equal(topLevelValue(pinned, 'interface-name'), 'enp0s5');
  const pinnedJSON = setTunEnabled(JSON.stringify({ 'mixed-port': 7890 }), true, { interfaceName: 'enp0s5' });
  assert.equal(JSON.parse(pinnedJSON).tun['auto-detect-interface'], false);
  assert.equal(JSON.parse(pinnedJSON)['interface-name'], 'enp0s5');
  const excluded = setTunEnabled(base, true, { interfaceName: 'enp0s5', excludeUid: 1234 });
  assert.match(excluded, /exclude-uid:/);
  assert.match(excluded, /^    - 1234$/m);
});

test('TUN 缺少 DNS 时补充可用 DNS 配置', () => {
  const withDns = ensureTunDns('mixed-port: 7890\n');
  assert.match(withDns, /^dns:$/m);
  assert.match(withDns, /^  enable: true$/m);
  assert.match(withDns, /fake-ip/);
  const existing = 'dns:\n  enable: false\n';
  assert.equal(ensureTunDns(existing), existing);
  const json = ensureTunDns(JSON.stringify({ 'mixed-port': 7890 }));
  assert.equal(JSON.parse(json).dns.enable, true);
});

test('识别 TUN 增强模式配置', () => {
  assert.equal(configInfo('tun:\n  enable: true\n  stack: system\nmixed-port: 7890\n').tunEnabled, true);
  assert.equal(configInfo('tun:\n  enable: false\n').tunEnabled, false);
  assert.equal(configInfo('tun: {enable: true}\n').tunEnabled, true);
  assert.equal(configInfo(JSON.stringify({ tun: { enable: true } })).tunEnabled, true);
  assert.equal(configInfo('mixed-port: 7890\n').tunEnabled, false);
});

test('读取端口、模式与局域网开关', () => {
  const info = configInfo(SOURCE);
  assert.deepEqual(info.ports, { mixed: 7890, http: 7891, socks: 7892 });
  assert.equal(info.mode, 'rule');
  assert.equal(info.allowLan, true);
  assert.equal(info.logLevel, 'debug');
});

test('替换顶层字段不会破坏其余配置', () => {
  const result = setTopLevel(SOURCE, 'mode', 'global');
  assert.equal((result.match(/^mode:/gm) || []).length, 1);
  assert.match(result, /^mode: global$/m);
  assert.match(result, /^mixed-port: 7890$/m);
  assert.match(result, /^  - MATCH,DIRECT$/m);
  assert.equal(topLevelValue(result, 'mode'), 'global');
});

test('拒绝空配置、超大配置与无效结构', () => {
  assert.throws(() => validateConfigSource(''), AppError);
  assert.throws(() => validateConfigSource('   \n'), AppError);
  assert.throws(() => validateConfigSource('a'.repeat(2 * 1024 * 1024 + 1)), /超过 2 MiB/);
  assert.throws(() => validateConfigSource('# only comments'), /无法识别配置结构/);
  assert.throws(() => validateConfigSource('{ bad json'), /JSON 配置解析失败/);
});
