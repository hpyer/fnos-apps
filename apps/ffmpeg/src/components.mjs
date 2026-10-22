import { FFmpegRepository, MAX_DOWNLOAD, targetArchitecture } from './repository.mjs';
import { downloadVerified } from './download.mjs';

const ORIGIN = 'https://ffmpeg.martin-riedl.de';
const TOOLS = ['ffmpeg', 'ffprobe'];
export function componentPath(entry, tool) {
  if (!TOOLS.includes(tool) || !['x64', 'arm64'].includes(entry.arch) || !/^\d{10}_\d+\.\d+\.\d+$/.test(entry.tag)) throw Error('组件构建标识无效');
  return `${ORIGIN}/download/linux/${entry.arch === 'x64' ? 'amd64' : 'arm64'}/${entry.tag}/${tool}.zip`;
}
export function parseComponentIndex(source, arch) {
  targetArchitecture('linux', arch);
  const stable = source.split(/<h2\b[^>]*>\s*Download Release Build\s*<\/h2>/i)[1]?.split(/<h2\b/i)[0];
  if (!stable) throw Error('独立组件来源没有稳定版列表');
  const architecture = arch === 'x64' ? 'amd64' : 'arm64';
  const pattern = new RegExp(`href="(/download/linux/${architecture}/(\\d{10}_(\\d+\\.\\d+\\.\\d+))/ffmpeg\\.zip)"`, 'g');
  const entries = new Map();
  for (const [, , tag, version] of stable.matchAll(pattern)) {
    const entry = { id: `martin-${tag}-${arch}`, arch, tag, version, build: version, branch: version,
      source: 'Martin Riedl', format: 'components', size: null, components: {} };
    for (const tool of TOOLS) entry.components[tool] = { url: componentPath(entry, tool), size: null };
    entries.set(entry.id, entry);
  }
  return [...entries.values()].sort((a, b) => Number(b.tag.split('_')[0]) - Number(a.tag.split('_')[0]));
}
async function textBody(response, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > limit) throw Error('组件来源返回的数据过大'); chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export class ComponentRepository {
  constructor({ platform = process.platform, arch = process.arch, fetcher = globalThis.fetch } = {}) {
    this.platform = platform; this.arch = arch; this.fetcher = fetcher;
    this.legacy = new FFmpegRepository({ platform, arch, fetcher });
  }
  async response(url, { signal, method = 'GET', headers = {} } = {}) {
    for (let index = 0; index < 4; index++) {
      const parsed = new URL(url);
      if (parsed.origin !== ORIGIN || parsed.username || parsed.password || parsed.search || parsed.hash ||
          !(parsed.pathname === '/' || /^\/download\/linux\/(amd64|arm64)\/\d{10}_\d+\.\d+\.\d+\/(ffmpeg|ffprobe)\.zip(?:\.sha256)?$/.test(parsed.pathname))) throw Error('组件下载地址不在允许名单中');
      let response;
      try { response = await this.fetcher(url, { method, signal, redirect: 'manual', cache: 'no-store', headers: { 'user-agent': 'fnos-ffmpeg-manager', 'cache-control': 'no-cache', ...headers } }); }
      catch (error) { if (signal?.aborted) throw error; throw Object.assign(Error('独立组件来源连接失败，请检查 NAS 出站网络', { cause: error }), { retryable: true }); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw Error('组件下载重定向无效'); url = new URL(location, url).href; continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(Error(`独立组件来源请求失败：HTTP ${response.status}`), { status: response.status, retryAfter: response.headers.get('retry-after') }); }
      return response;
    }
    throw Error('组件下载重定向次数过多');
  }
  async asset(entry, tool, { signal } = {}) {
    const url = componentPath(entry, tool), known = entry.components?.[tool];
    if (known?.url !== url) throw Error('组件来源记录无效');
    if (/^[a-f0-9]{64}$/.test(known.sha256)) return { ...known };
    const response = await this.response(url + '.sha256', { signal });
    const text = (await textBody(response, 4096)).trim();
    const sha256 = new RegExp(`^([a-f0-9]{64})(?:\\s+\\*?${tool}\\.zip)?$`, 'i').exec(text)?.[1]?.toLowerCase();
    if (!sha256) throw Error('组件 SHA256 清单格式无效');
    let size = null;
    try {
      const head = await this.response(url, { signal, method: 'HEAD' });
      const value = head.headers.get('content-length');
      if (/^\d+$/.test(value || '') && Number.isSafeInteger(Number(value)) && Number(value) > 0) size = Number(value);
      await head.body?.cancel();
    } catch { if (signal?.aborted) signal.throwIfAborted(); }
    if (size !== null && size > MAX_DOWNLOAD) throw Error('组件下载体积超过限制');
    return { url, sha256, size };
  }
  async catalog() {
    targetArchitecture(this.platform, this.arch);
    const signal = AbortSignal.timeout(30000);
    const response = await this.response(ORIGIN + '/', { signal });
    const entries = parseComponentIndex(await textBody(response, 2 * 1024 * 1024), this.arch);
    if (!entries.length) throw Error('没有找到当前架构的独立稳定版组件');
    for (const entry of entries.slice(0, 3)) {
      entry.components.ffmpeg = await this.asset(entry, 'ffmpeg', { signal });
      entry.size = entry.components.ffmpeg.size;
    }
    return entries.slice(0, 3);
  }
  async downloadComponent(entry, tool, destination, { signal, ...options } = {}) {
    if (entry.arch !== this.arch) throw Error('组件架构不匹配');
    const lookupSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    const asset = await this.asset(entry, tool, { signal: lookupSignal });
    const size = await downloadVerified({ ...options, destination, signal, label: tool, sha256: asset.sha256, size: asset.size,
      request: settings => this.response(asset.url, settings) });
    return { ...asset, size };
  }
  download(entry, destination, options) { return this.legacy.download(entry, destination, options); }
}
