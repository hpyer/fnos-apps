import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULTS = Object.freeze({ port: 3080, channels: ['latest'], registry: 'https://mirrors.cloud.tencent.com/npm', publicHost: '' });

function loopbackHost(host) { return host === 'localhost' || host.startsWith('127.') || host === '[::1]'; }

export function validatePublicHost(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error('NAS 访问地址必须是 IP 或域名');
  const input = value.trim();
  let url;
  try { url = new URL(`http://${input}`); }
  catch { throw new Error('NAS 访问地址必须是 IP 或域名，不含协议和端口'); }
  if (!input || url.hostname !== input.toLowerCase() || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('NAS 访问地址必须是 IP 或域名，不含协议和端口');
  }
  if (loopbackHost(url.hostname)) {
    throw new Error('NAS 访问地址不能使用 localhost 或回环地址，请填写浏览器访问 NAS 使用的 IP 或域名');
  }
  return url.hostname;
}
export function validateConfig(input) {
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须是 1024–65535 的整数');
  if (!Array.isArray(input.channels) || input.channels.some(x => !['latest', 'alpha', 'beta', 'next'].includes(x))) throw new Error('无效的更新标签');
  const registry = new URL(input.registry);
  if (registry.protocol !== 'https:' || registry.username || registry.password || registry.search || registry.hash) throw new Error('registry 必须是不含凭据和查询参数的 HTTPS 地址');
  return {
    port,
    channels: [...new Set(['latest', ...input.channels])],
    registry: registry.href.replace(/\/$/, ''),
    publicHost: validatePublicHost(input.publicHost),
  };
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback); throw error; }
}
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
export async function loadConfig(root) {
  const config = await readJson(path.join(root, 'config.json'), DEFAULTS);
  // An older build accepted a loopback address. It points at the administrator's
  // browser, not the NAS, so preserve the service by treating it as unset.
  if (typeof config.publicHost === 'string' && loopbackHost(config.publicHost.trim().toLowerCase())) config.publicHost = '';
  return validateConfig(config);
}
