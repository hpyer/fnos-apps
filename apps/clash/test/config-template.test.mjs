import assert from 'node:assert/strict';
import { test } from 'node:test';
import { augmentSubscriptionConfig, defaultConfig } from '../src/config-template.mjs';
import { configInfo, directProxies, proxyProviders, validateConfigSource } from '../src/yaml.mjs';

test('默认配置包含可替换的提供商、分组和规则', () => {
  const source = defaultConfig();
  assert.doesNotThrow(() => validateConfigSource(source));
  assert.deepEqual(proxyProviders(source), [{ name: '默认订阅', type: 'http', interval: 86400 }]);
  assert.match(source, /url: ""/);
  assert.match(source, /填入你的订阅链接/);
  assert.match(source, /proxy-groups:/);
  assert.match(source, /use:\n      - 默认订阅/);
  assert.match(source, /GEOIP,CN,DIRECT/);
  assert.match(source, /MATCH,节点选择/);
  assert.deepEqual(directProxies(source), []);
  assert.equal(configInfo(source).mode, 'rule');
});

test('仅有 proxies 的订阅会补齐分组和规则', () => {
  const source = [
    'proxies:',
    '  - name: "香港 01"',
    '    type: ss',
    '    server: 1.2.3.4',
    '    port: 443',
    '    cipher: aes-128-gcm',
    '    password: secret',
    '  - name: 日本-02',
    '    type: vmess',
    '    server: b.example.com',
    '    port: 443',
    '    uuid: 1234',
    '    alterId: 0',
    '    cipher: auto',
    '',
  ].join('\n');
  const augmented = augmentSubscriptionConfig(source);
  assert.deepEqual(augmented.added, ['proxy-groups', 'rules']);
  assert.deepEqual(directProxies(augmented.source), ['香港 01', '日本-02']);
  assert.match(augmented.source, /- name: 节点选择/);
  assert.match(augmented.source, /- name: 自动选择/);
  assert.match(augmented.source, /- 香港 01/);
  assert.match(augmented.source, /MATCH,节点选择/);
  assert.doesNotThrow(() => validateConfigSource(augmented.source));
});

test('完整订阅与带规则的订阅不会被改写', () => {
  const full = 'proxies:\n  - name: A\n    type: ss\nproxy-groups:\n  - name: G\n    type: select\n    proxies:\n      - A\nrules:\n  - MATCH,G\n';
  assert.deepEqual(augmentSubscriptionConfig(full).added, []);
  assert.equal(augmentSubscriptionConfig(full).source, full);
  const rulesOnly = 'proxies:\n  - name: A\n    type: ss\nrules:\n  - MATCH,DIRECT\n';
  assert.deepEqual(augmentSubscriptionConfig(rulesOnly).added, []);
  const empty = 'mixed-port: 7890\nproxies: []\nrules:\n  - MATCH,DIRECT\n';
  assert.deepEqual(augmentSubscriptionConfig(empty).added, []);
  assert.equal(augmentSubscriptionConfig(empty).source, empty);
});

test('JSON 订阅同样补齐分组和规则', () => {
  const source = JSON.stringify({ proxies: [{ name: 'JSON 节点', type: 'ss' }, { name: 'B', type: 'vmess' }] });
  const augmented = augmentSubscriptionConfig(source);
  assert.deepEqual(augmented.added, ['proxy-groups', 'rules']);
  const value = JSON.parse(augmented.source);
  assert.equal(value['proxy-groups'][0].name, '节点选择');
  assert.deepEqual(value['proxy-groups'][1].proxies, ['JSON 节点', 'B']);
  assert.ok(value.rules.includes('MATCH,节点选择'));
});

test('空的 proxy-groups/rules 视为缺失并补齐', () => {
  const source = 'proxies:\n  - name: A\n    type: ss\nproxy-groups: []\nrules: []\n';
  const augmented = augmentSubscriptionConfig(source);
  assert.deepEqual(augmented.added, ['proxy-groups', 'rules']);
  assert.match(augmented.source, /- name: 节点选择/);
});
