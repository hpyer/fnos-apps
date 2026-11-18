import { directProxies, hasConfigSectionValue, looksJSON } from './yaml.mjs';

const TEST_URL = 'https://www.gstatic.com/generate_204';

const BASIC_RULES = [
  'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
  'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
  'GEOIP,CN,DIRECT',
  'MATCH,节点选择',
];

/**
 * Fresh-install configuration: a placeholder provider plus a minimal set of
 * groups and rules. Users only need to replace the provider URL and apply.
 */
export function defaultConfig() {
  return [
    '# Clash for fnOS 默认配置',
    '#',
    '# 使用机场订阅（推荐）：',
    '#   1. 在下方 proxy-providers → 默认订阅 → url 中填入机场的',
    '#      「Clash 提供商 / 节点列表」订阅链接（不是完整配置链接）。',
    '#   2. 保存并应用后，在「代理 → 代理提供商」查看节点，',
    '#      在「节点选择」策略组中切换出口即可。',
    '#   3. 如果机场只提供「Clash 订阅」完整配置链接，请改用「订阅」功能导入，',
    '#      应用时会自动补齐策略组和基础规则。',
    '#',
    '# 端口、局域网访问和日志级别由「设置」页接管，无需在此修改。',
    '',
    'mixed-port: 7890',
    'allow-lan: false',
    'bind-address: "*"',
    'mode: rule',
    'log-level: info',
    'ipv6: false',
    '',
    'proxy-providers:',
    '  默认订阅:',
    '    type: http',
    '    url: ""  # ← 填入你的订阅链接',
    '    interval: 86400',
    '    path: ./providers/default.yaml',
    '    health-check:',
    '      enable: true',
    `      url: ${TEST_URL}`,
    '      interval: 600',
    '',
    'proxy-groups:',
    '  - name: 节点选择',
    '    type: select',
    '    proxies:',
    '      - 自动选择',
    '      - DIRECT',
    '    use:',
    '      - 默认订阅',
    '  - name: 自动选择',
    '    type: url-test',
    '    use:',
    '      - 默认订阅',
    `    url: ${TEST_URL}`,
    '    interval: 300',
    '    tolerance: 50',
    '',
    'rules:',
    ...BASIC_RULES.map(rule => `  - ${rule}`),
    '',
  ].join('\n');
}

/**
 * Subscriptions that only contain a proxy list (provider-style links) have no
 * groups or rules, so the page cannot route anything. Add the same minimal
 * groups/rules as the default config and report what was added.
 */
export function augmentSubscriptionConfig(source) {
  if (typeof source !== 'string' || !source.trim()) return { source, added: [] };
  if (hasConfigSectionValue(source, 'proxy-groups') || hasConfigSectionValue(source, 'rules')) return { source, added: [] };
  const nodes = collectNodes(source);
  if (!nodes.length) return { source, added: [] };
  const groups = buildGroups(nodes);
  if (looksJSON(source)) {
    let value;
    try { value = JSON.parse(source); } catch { return { source, added: [] }; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { source, added: [] };
    value['proxy-groups'] = groups;
    value.rules = BASIC_RULES;
    return { source: `${JSON.stringify(value, null, 2)}\n`, added: ['proxy-groups', 'rules'] };
  }
  const body = source.replace(/\s*$/, '');
  return { source: `${body}\n\n${renderGroups(groups)}${renderRules()}`, added: ['proxy-groups', 'rules'] };
}

function collectNodes(source) {
  return directProxies(source);
}

function buildGroups(nodes) {
  return [
    { name: '节点选择', type: 'select', proxies: ['自动选择', 'DIRECT'] },
    { name: '自动选择', type: 'url-test', proxies: nodes, url: TEST_URL, interval: 300, tolerance: 50 },
  ];
}

function renderGroups(groups) {
  const lines = ['proxy-groups:'];
  for (const group of groups) {
    lines.push(`  - name: ${yamlString(group.name)}`, `    type: ${group.type}`, '    proxies:');
    for (const proxy of group.proxies) lines.push(`      - ${yamlString(proxy)}`);
    if (group.url) lines.push(`    url: ${group.url}`, `    interval: ${group.interval}`, `    tolerance: ${group.tolerance}`);
  }
  return `${lines.join('\n')}\n\n`;
}

function renderRules() {
  return `rules:\n${BASIC_RULES.map(rule => `  - ${rule}`).join('\n')}\n`;
}

function yamlString(value) {
  const text = String(value);
  // Keep common names readable; quote anything with YAML-special characters.
  return /^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff ._-]*$/.test(text) ? text : JSON.stringify(text);
}
