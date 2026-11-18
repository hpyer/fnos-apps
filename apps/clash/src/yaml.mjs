import { fail } from './errors.mjs';

// A deliberately small YAML inspector for the top level of a Clash configuration.
// It never tries to interpret nested structures: mihomo's `-t` remains the
// authoritative syntax/semantic check. This is only used to read display fields,
// strip controller keys we must own, and inject the managed controller socket.
const MAX_CONFIG = 2 * 1024 * 1024;
const BLOCKED = ['external-controller', 'external-controller-tls', 'external-controller-pipe',
  'external-controller-unix', 'external-controller-cors', 'external-doh-server', 'external-ui',
  'external-ui-url', 'external-ui-name', 'secret', 'log-level'];
const MANAGED_NETWORK = ['mixed-port', 'port', 'socks-port', 'allow-lan'];
const PORT_KEYS = { 'mixed-port': 'mixed', port: 'http', 'socks-port': 'socks', 'redir-port': 'redir', 'tproxy-port': 'tproxy' };

export function looksJSON(source) {
  return String(source).trimStart().startsWith('{');
}

function splitTopLevel(source) {
  const lines = String(source).split(/\r?\n/);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || /^\s/.test(line) || /^\s*#/.test(line)) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line);
    if (match) entries.push({ key: match[1], raw: match[2], index });
  }
  for (const entry of entries) {
    let end = lines.length;
    for (let index = entry.index + 1; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      if (!/^\s/.test(lines[index])) { end = index; break; }
    }
    while (end > entry.index + 1 && !lines[end - 1].trim()) end -= 1;
    entry.end = end;
  }
  return { lines, entries };
}

function unquote(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    let result = '', index = 1;
    for (; index < value.length; index += 1) {
      const character = value[index];
      if (character === '\\' && quote === '"' && index + 1 < value.length) { result += value[index + 1]; index += 1; continue; }
      if (character === quote) return result;
      result += character;
    }
    return result;
  }
  const comment = value.search(/\s#/);
  if (comment >= 0) value = value.slice(0, comment);
  return value.trim();
}

function scalar(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function parseJSONSource(source) {
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('配置必须是 JSON 对象或 YAML 映射');
    return value;
  } catch (error) {
    if (error.name === 'AppError') throw error;
    fail(`JSON 配置解析失败：${error.message}`);
  }
}

function yamlEntries(source) {
  const { lines, entries } = splitTopLevel(source);
  return { lines, entries, remove(keys) {
    const drop = new Set(keys);
    const skip = new Set();
    for (const entry of entries) if (drop.has(entry.key)) for (let index = entry.index; index < entry.end; index += 1) skip.add(index);
    return lines.filter((_, index) => !skip.has(index));
  } };
}

function tunEnabled(source) {
  if (looksJSON(source)) {
    const value = parseJSONSource(source);
    return value.tun?.enable === true;
  }
  const { entries, lines } = splitTopLevel(source);
  const entry = entries.find(item => item.key === 'tun');
  if (!entry) return false;
  if (/enable\s*:\s*true/.test(entry.raw)) return true;
  for (let index = entry.index + 1; index < entry.end; index += 1) {
    if (/^\s+enable\s*:\s*true\s*(?:#.*)?$/.test(lines[index])) return true;
  }
  return false;
}

export function validateConfigSource(source) {
  if (typeof source !== 'string' || !source.trim()) fail('配置内容不能为空');
  if (Buffer.byteLength(source) > MAX_CONFIG) fail('配置内容超过 2 MiB 限制');
  if (source.includes('\u0000')) fail('配置内容包含非法字符');
  if (looksJSON(source)) {
    const value = parseJSONSource(source);
    if (!Object.keys(value).length) fail('配置不能是空对象');
    return value;
  }
  const { entries } = splitTopLevel(source);
  if (!entries.length) fail('无法识别配置结构，请粘贴 Clash YAML 配置');
  return null;
}

/** Read the top-level proxy-providers names and non-secret display fields. */
export function proxyProviders(source) {
  if (looksJSON(source)) {
    const value = parseJSONSource(source);
    const providers = value['proxy-providers'];
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
    return Object.entries(providers).filter(([, item]) => item && typeof item === 'object').map(([name, item]) => ({
      name,
      type: typeof item.type === 'string' ? item.type : '',
      interval: Number(item.interval) || 0,
    }));
  }
  const { lines, entries } = splitTopLevel(source);
  const entry = entries.find(item => item.key === 'proxy-providers');
  if (!entry || entry.raw.trim().startsWith('{')) return [];
  const block = [];
  for (let index = entry.index + 1; index < entry.end; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    block.push({ line, indent: /^\s*/.exec(line)[0].length });
  }
  if (!block.length) return [];
  const baseIndent = Math.min(...block.map(item => item.indent));
  const providers = [];
  let current = null;
  let propertyIndent = null;
  for (const item of block) {
    const text = item.line.trim();
    if (item.indent === baseIndent) {
      const match = /^(.+?)\s*:\s*(.*)$/.exec(text);
      if (!match) continue;
      current = { name: unquote(match[1]), type: '', interval: 0 };
      propertyIndent = null;
      const inline = /type\s*:\s*([^,}\s]+)/.exec(match[2]);
      if (inline) current.type = unquote(inline[1]);
      providers.push(current);
    } else if (current) {
      // Only direct children define provider options; health-check.interval etc. stay nested.
      if (propertyIndent === null) propertyIndent = item.indent;
      if (item.indent !== propertyIndent) continue;
      const match = /^(type|interval)\s*:\s*(.*)$/.exec(text);
      if (!match) continue;
      if (match[1] === 'type') current.type = unquote(match[2]);
      else current.interval = Number(unquote(match[2])) || 0;
    }
  }
  return providers.filter(item => item.name);
}

/** Names of proxies defined directly in the config (proxy-providers are separate). */
export function directProxies(source) {
  if (looksJSON(source)) {
    const value = parseJSONSource(source);
    if (!Array.isArray(value.proxies)) return [];
    return value.proxies
      .map(item => (item && typeof item === 'object' ? item.name : ''))
      .filter(name => typeof name === 'string' && name.trim())
      .map(name => name.trim());
  }
  const { lines, entries } = splitTopLevel(source);
  const entry = entries.find(item => item.key === 'proxies');
  if (!entry) return [];
  const raw = entry.raw.trim();
  if (raw.startsWith('[')) {
    const names = [];
    const pattern = /\bname\s*:\s*(?:"([^"]+)"|'([^']+)'|([^,}\]]+))/g;
    let match;
    while ((match = pattern.exec(raw))) {
      const name = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (name) names.push(name);
    }
    return names;
  }
  if (raw && !raw.startsWith('#')) return [];
  const block = [];
  for (let index = entry.index + 1; index < entry.end; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    block.push({ line, indent: /^\s*/.exec(line)[0].length });
  }
  if (!block.length) return [];
  const baseIndent = Math.min(...block.map(item => item.indent));
  const names = [];
  for (const item of block) {
    if (item.indent !== baseIndent) continue;
    const text = item.line.trim();
    if (!text.startsWith('-')) continue;
    const rest = text.slice(1).trim();
    const inline = /^name\s*:\s*(.+)$/.exec(rest);
    if (inline) {
      const name = unquote(inline[1]);
      if (name) names.push(name);
      continue;
    }
    if (rest.startsWith('{')) {
      const match = /name\s*:\s*(?:"([^"]+)"|'([^']+)'|([^,}]+))/.exec(rest);
      const name = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
      if (name) names.push(name);
    }
  }
  return names;
}

export function configInfo(source) {
  const info = { ports: {}, allowLan: null, mode: '', logLevel: '', keys: [], proxyCount: null, tunEnabled: false, tunDevice: '' };
  if (looksJSON(source)) {
    const value = parseJSONSource(source);
    info.keys = Object.keys(value);
    for (const [key, name] of Object.entries(PORT_KEYS)) {
      const port = Number(value[key]);
      if (Number.isInteger(port) && port > 0 && port < 65536) info.ports[name] = port;
    }
    if (typeof value['allow-lan'] === 'boolean') info.allowLan = value['allow-lan'];
    if (typeof value.mode === 'string') info.mode = value.mode;
    if (typeof value['log-level'] === 'string') info.logLevel = value['log-level'];
    if (Array.isArray(value.proxies)) info.proxyCount = value.proxies.length;
    info.tunEnabled = value.tun?.enable === true;
    if (typeof value.tun?.device === 'string') info.tunDevice = value.tun.device;
    return info;
  }
  for (const entry of splitTopLevel(source).entries) {
    info.keys.push(entry.key);
    const value = unquote(entry.raw);
    if (PORT_KEYS[entry.key]) {
      const port = Number(value);
      if (Number.isInteger(port) && port > 0 && port < 65536) info.ports[PORT_KEYS[entry.key]] = port;
    }
    if (entry.key === 'allow-lan') info.allowLan = value === 'true';
    if (entry.key === 'mode') info.mode = value;
    if (entry.key === 'log-level') info.logLevel = value;
  }
  info.tunEnabled = tunEnabled(source);
  const tunEntry = splitTopLevel(source).entries.find(item => item.key === 'tun');
  if (tunEntry) {
    const inline = /device\s*:\s*["']?([^"'\s#,]+)/.exec(tunEntry.raw);
    if (inline) info.tunDevice = inline[1];
    else {
      for (let index = tunEntry.index + 1; index < tunEntry.end; index += 1) {
        const match = /^\s+device\s*:\s*["']?([^"'\s#,]+)/.exec(splitTopLevel(source).lines[index] || '');
        if (match) { info.tunDevice = match[1]; break; }
      }
    }
  }
  return info;
}


/** Set tun.enable while preserving the rest of the user configuration. */
/** Build a minimal TUN DNS block, reusing the host's working resolvers. */
function tunDnsBlock(nameservers) {
  const servers = nameservers.length ? nameservers : ['223.5.5.5', '119.29.29.29'];
  const list = values => values.map(value => `    - ${value}`).join('\n');
  return `dns:\n  enable: true\n  listen: 0.0.0.0:1053\n  ipv6: false\n  enhanced-mode: fake-ip\n  fake-ip-range: 198.18.0.1/16\n  default-nameserver:\n${list(servers)}\n  nameserver:\n${list(servers)}\n`;
}

/** Add or repair the TUN DNS block. Existing custom DNS is preserved unless it looks auto-generated. */
export function ensureTunDns(source, { nameservers = [] } = {}) {
  const block = tunDnsBlock(nameservers);
  if (looksJSON(source)) {
    const object = parseJSONSource(source);
    const current = object.dns && typeof object.dns === 'object' ? object.dns : null;
    if (current && !/223\.5\.5\.5|119\.29\.29\.29|1\.1\.1\.1/.test(JSON.stringify(current))) return source;
    const servers = nameservers.length ? nameservers : ['223.5.5.5', '119.29.29.29'];
    object.dns = { ...(current || {}), enable: true, listen: '0.0.0.0:1053', ipv6: false, 'enhanced-mode': 'fake-ip', 'fake-ip-range': '198.18.0.1/16', 'default-nameserver': servers, nameserver: servers };
    return `${JSON.stringify(object, null, 2)}\n`;
  }
  const { lines, entries } = splitTopLevel(source);
  const entry = entries.find(item => item.key === 'dns');
  if (!entry) return `${String(source).replace(/\s+$/, '')}\n${block}`;
  const existing = lines.slice(entry.index, entry.end).join('\n');
  if (!/223\.5\.5\.5|119\.29\.29\.29|1\.1\.1\.1/.test(existing)) return source;
  lines.splice(entry.index, entry.end - entry.index, ...block.replace(/\n$/, '').split('\n'));
  return `${lines.join('\n').replace(/\s+$/, '')}\n`;
}

export function setTunEnabled(source, enabled, { interfaceName = '', excludeUid = null } = {}) {
  const value = enabled === true;
  if (looksJSON(source)) {
    const object = parseJSONSource(source);
    const tun = { ...(object.tun && typeof object.tun === 'object' ? object.tun : {}), enable: value };
    if (value) {
      if (tun['auto-route'] === undefined) tun['auto-route'] = true;
      if (interfaceName) tun['auto-detect-interface'] = false;
      else if (tun['auto-detect-interface'] === undefined) tun['auto-detect-interface'] = true;
      if (tun['dns-hijack'] === undefined) tun['dns-hijack'] = ['any:53'];
      if (tun.stack === undefined) tun.stack = 'system';
      if (excludeUid !== null && tun['exclude-uid'] === undefined) tun['exclude-uid'] = [excludeUid];
    }
    object.tun = tun;
    if (interfaceName) object['interface-name'] = interfaceName;
    return `${JSON.stringify(object, null, 2)}\n`;
  }
  const { lines, entries } = splitTopLevel(source);
  const entry = entries.find(item => item.key === 'tun');
  if (!entry) {
    const detect = interfaceName ? 'false' : 'true';
    const exclude = excludeUid !== null ? `  exclude-uid:\n    - ${excludeUid}\n` : '';
    const block = `${String(source).replace(/\s+$/, '')}\ntun:\n  enable: ${value}\n  stack: system\n  auto-route: true\n  auto-detect-interface: ${detect}\n  dns-hijack:\n    - any:53\n${exclude}`;
    return interfaceName ? setTopLevel(block, 'interface-name', interfaceName) : block;
  }
  if (entry.raw.trim().startsWith('{')) {
    let raw = entry.raw.replace(/enable\s*:\s*(?:true|false)/, `enable: ${value}`);
    if (!/enable\s*:/.test(raw)) raw = raw.replace(/\{\s*/, `{ enable: ${value}, `);
    if (value) {
      if (!/auto-route\s*:/.test(raw)) raw = raw.replace(/\{\s*/, '{ auto-route: true, ');
      if (interfaceName) {
        if (/auto-detect-interface\s*:/.test(raw)) raw = raw.replace(/auto-detect-interface\s*:\s*(?:true|false)/, 'auto-detect-interface: false');
        else raw = raw.replace(/\{\s*/, '{ auto-detect-interface: false, ');
      } else if (!/auto-detect-interface\s*:/.test(raw)) raw = raw.replace(/\{\s*/, '{ auto-detect-interface: true, ');
      if (!/dns-hijack\s*:/.test(raw)) raw = raw.replace(/\{\s*/, '{ dns-hijack: [any:53], ');
      if (!/stack\s*:/.test(raw)) raw = raw.replace(/\{\s*/, '{ stack: system, ');
      if (excludeUid !== null && !/exclude-uid\s*:/.test(raw)) raw = raw.replace(/\{\s*/, `{ exclude-uid: [${excludeUid}], `);
    }
    lines[entry.index] = `tun:${raw}`;
    const result = `${lines.join('\n').replace(/\s+$/, '')}\n`;
    return interfaceName ? setTopLevel(result, 'interface-name', interfaceName) : result;
  }
  let indent = '  ';
  for (let index = entry.index + 1; index < entry.end; index += 1) {
    const match = /^(\s+)\S/.exec(lines[index]);
    if (match) { indent = match[1]; break; }
  }
  let replaced = false;
  for (let index = entry.index + 1; index < entry.end; index += 1) {
    if (/^\s*enable\s*:/.test(lines[index])) {
      lines[index] = `${indent}enable: ${value}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.splice(entry.index + 1, 0, `${indent}enable: ${value}`);
  if (value) {
    const body = lines.slice(entry.index + 1, entry.end + (replaced ? 0 : 1));
    const has = key => body.some(line => new RegExp(`^\\s+${key}\\s*:`).test(line));
    const additions = [];
    if (!has('stack')) additions.push(`${indent}stack: system`);
    if (!has('auto-route')) additions.push(`${indent}auto-route: true`);
    if (!has('auto-detect-interface')) additions.push(`${indent}auto-detect-interface: ${interfaceName ? 'false' : 'true'}`);
    if (!has('dns-hijack')) additions.push(`${indent}dns-hijack:`, `${indent}  - any:53`);
    if (excludeUid !== null && !has('exclude-uid')) additions.push(`${indent}exclude-uid:`, `${indent}  - ${excludeUid}`);
    if (additions.length) lines.splice(entry.index + 1, 0, ...additions);
  }
  if (interfaceName) {
    for (let index = entry.index + 1; index < entry.end; index += 1) {
      if (/^\s*auto-detect-interface\s*:/.test(lines[index])) {
        lines[index] = lines[index].replace(/auto-detect-interface\s*:\s*(?:true|false)/, 'auto-detect-interface: false');
      }
    }
  }
  const result = `${lines.join('\n').replace(/\s+$/, '')}\n`;
  return interfaceName ? setTopLevel(result, 'interface-name', interfaceName) : result;
}

/** True when a top-level mapping/list key exists and is not empty or comment-only. */
export function hasConfigSectionValue(source, key) {
  if (looksJSON(source)) {
    const value = parseJSONSource(source)[key];
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return value !== undefined && value !== null && String(value).trim() !== '';
  }
  const { lines, entries } = splitTopLevel(source);
  const entry = entries.find(item => item.key === key);
  if (!entry) return false;
  const raw = entry.raw.trim();
  if (raw && !raw.startsWith('#')) {
    if (raw.startsWith('[')) return raw.replace(/^\[|\]$/g, '').trim().length > 0;
    return true;
  }
  for (let index = entry.index + 1; index < entry.end; index += 1) {
    if (lines[index].trim() && !/^\s*#/.test(lines[index])) return true;
  }
  return false;
}

export function topLevelValue(source, key) {
  if (looksJSON(source)) return parseJSONSource(source)[key];
  const entry = splitTopLevel(source).entries.find(item => item.key === key);
  return entry ? unquote(entry.raw) : undefined;
}

/** Replace one top-level scalar without re-serialising the whole configuration. */
export function setTopLevel(source, key, value) {
  if (looksJSON(source)) {
    const object = parseJSONSource(source);
    object[key] = value;
    return `${JSON.stringify(object, null, 2)}\n`;
  }
  const { remove } = yamlEntries(source);
  const lines = remove([key]);
  return `${lines.join('\n').replace(/\s+$/, '')}\n${key}: ${scalar(value)}\n`;
}

/** Remove controller/secret keys owned by the app and append the managed block. */
export function injectController(source, { socketPath, secret, logLevel = 'info', network = null, health = null }) {
  if (!socketPath) fail('缺少 Controller Socket 路径');
  const blocked = [...BLOCKED, ...(network ? MANAGED_NETWORK : []), ...(health ? ['unified-delay', 'tcp-concurrent'] : [])];
  if (looksJSON(source)) {
    const object = parseJSONSource(source);
    for (const key of blocked) delete object[key];
    object['external-controller-unix'] = socketPath;
    object.secret = secret;
    object['log-level'] = logLevel;
    if (network) {
      object['mixed-port'] = network.ports.mixed;
      if (network.ports.http > 0) object.port = network.ports.http; else delete object.port;
      if (network.ports.socks > 0) object['socks-port'] = network.ports.socks; else delete object['socks-port'];
      object['allow-lan'] = network.allowLan === true;
    }
    if (health) {
      object['unified-delay'] = health.unifiedDelay === true;
      object['tcp-concurrent'] = health.tcpConcurrent === true;
    }
    return `${JSON.stringify(object, null, 2)}\n`;
  }
  const { remove } = yamlEntries(source);
  const body = remove(blocked).join('\n').replace(/\s+$/, '');
  const lines = [
    body,
    '',
    '# 以下字段由 Clash for fnOS 托管，修改后会在下次启动或应用配置时被覆盖。',
    `external-controller-unix: ${scalar(socketPath)}`,
    `secret: ${scalar(secret)}`,
    `log-level: ${scalar(logLevel)}`,
  ];
  if (network) {
    lines.push(`mixed-port: ${network.ports.mixed}`);
    if (network.ports.http > 0) lines.push(`port: ${network.ports.http}`);
    if (network.ports.socks > 0) lines.push(`socks-port: ${network.ports.socks}`);
    lines.push(`allow-lan: ${network.allowLan === true}`);
  }
  if (health) {
    lines.push(`unified-delay: ${health.unifiedDelay === true}`);
    lines.push(`tcp-concurrent: ${health.tcpConcurrent === true}`);
  }
  lines.push('');
  return lines.join('\n');
}
