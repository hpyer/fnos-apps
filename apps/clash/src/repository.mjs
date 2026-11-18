import { AppError, fail } from './errors.mjs';
import { downloadUnverified, downloadVerified, MAX_CORE_DOWNLOAD } from './download.mjs';

const API = 'https://api.github.com';
const DOWNLOAD = 'https://github.com';
const RAW = 'https://raw.githubusercontent.com';
const ALPHA_TAG = 'Prerelease-Alpha';
const MAX_API_BODY = 8 * 1024 * 1024;

export const CHANNELS = {
  'metacubex-stable': {
    id: 'metacubex-stable',
    label: '稳定版',
    repository: 'MetaCubeX/mihomo',
    source: 'https://github.com/MetaCubeX/mihomo',
    license: 'GPL-3.0',
    risk: false,
  },
  'metacubex-test': {
    id: 'metacubex-test',
    label: '测试版',
    repository: 'MetaCubeX/mihomo',
    source: 'https://github.com/MetaCubeX/mihomo',
    license: 'GPL-3.0',
    tag: ALPHA_TAG,
    risk: true,
  },
  smart: {
    id: 'smart',
    label: 'Smart版',
    repository: 'vernesong/mihomo',
    source: 'https://github.com/vernesong/mihomo',
    license: 'GPL-3.0',
    tag: ALPHA_TAG,
    risk: true,
  },
};

export function channelConfig(id) {
  const channel = CHANNELS[id];
  if (!channel) fail('未知的 Core 更新渠道');
  return channel;
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if ((a[index] || 0) !== (b[index] || 0)) return (b[index] || 0) - (a[index] || 0);
  return 0;
}

function digestOf(asset) {
  const value = typeof asset.digest === 'string' ? asset.digest : '';
  return /^sha256:[a-f0-9]{64}$/.test(value) ? value.slice(7) : '';
}

function assetEntry({ channel, asset, arch, version, tag, commit, publishedAt, prerelease }) {
  if (asset.state && asset.state !== 'uploaded') return null;
  const url = `${DOWNLOAD}/${channel.repository}/releases/download/${tag}/${asset.name}`;
  if (asset.browser_download_url !== url) return null;
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_CORE_DOWNLOAD) return null;
  const sha256 = digestOf(asset);
  return {
    id: `${channel.id}-${version ? `v${version}` : commit}-${arch}`,
    channel: channel.id,
    channelLabel: channel.label,
    version: version ? `v${version}` : '',
    build: commit || '',
    tag,
    arch,
    name: asset.name,
    url,
    sha256,
    size: asset.size,
    verified: Boolean(sha256),
    prerelease: Boolean(prerelease),
    risk: channel.risk,
    source: channel.source,
    repository: channel.repository,
    license: channel.license,
    publishedAt: Number.isFinite(Date.parse(publishedAt)) ? new Date(publishedAt).toISOString() : '',
  };
}

/** Parse a GitHub release into arch-specific mihomo assets. Exported for tests. */
export function parseRelease(release, channelId) {
  const channel = channelConfig(channelId);
  if (!release || release.draft) return [];
  const archPattern = { x86_64: 'amd64', arm64: 'arm64' };
  const entries = [];
  if (channel.tag) {
    if (release.tag_name !== channel.tag) return [];
    const suffix = channel.id === 'smart' ? 'alpha-smart' : 'alpha';
    for (const [arch, token] of Object.entries(archPattern)) {
      const pattern = new RegExp(`^mihomo-linux-${token}-${suffix}-([0-9a-f]{7,40})\\.gz$`);
      for (const asset of Array.isArray(release.assets) ? release.assets : []) {
        const match = pattern.exec(asset.name);
        if (!match) continue;
        const entry = assetEntry({ channel, asset, arch, version: '', tag: release.tag_name, commit: match[1], publishedAt: release.published_at, prerelease: true });
        if (entry) entries.push(entry);
      }
    }
    return entries;
  }
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name || '') || release.prerelease) return [];
  const version = release.tag_name.slice(1);
  for (const [arch, token] of Object.entries(archPattern)) {
    const name = `mihomo-linux-${token}-${release.tag_name}.gz`;
    const asset = (Array.isArray(release.assets) ? release.assets : []).find(item => item.name === name);
    if (!asset) continue;
    const entry = assetEntry({ channel, asset, arch, version, tag: release.tag_name, commit: '', publishedAt: release.published_at, prerelease: false });
    if (entry) entries.push(entry);
  }
  return entries;
}

export class CoreRepository {
  constructor({ fetcher = globalThis.fetch, now = Date.now, mirror = value => value, unmirror = value => value } = {}) {
    this.fetcher = fetcher;
    this.now = now;
    this.mirror = mirror;
    this.unmirror = unmirror;
  }

  allowed(url, channel) {
    const value = new URL(url);
    if (value.protocol !== 'https:' || value.username || value.password || value.port) return false;
    const repository = channel.repository;
    if (value.origin === API) return value.pathname.startsWith(`/repos/${repository}/`);
    if (value.origin === DOWNLOAD) return value.pathname.startsWith(`/${repository}/releases/download/`) || value.pathname === `/${repository}/releases.atom` || value.pathname.startsWith(`/${repository}/releases/expanded_assets/`);
    if (value.origin === RAW) return value.pathname.startsWith(`/${repository}/`);
    return value.hostname === 'release-assets.githubusercontent.com' || value.hostname === 'objects.githubusercontent.com';
  }

  async request(url, channel, { signal, headers = {}, api = false } = {}) {
    let current = url;
    for (let hop = 0; hop < 6; hop += 1) {
      if (!this.allowed(current, channel)) fail('下载来源不在允许名单中');
      const target = this.mirror(current);
      const requestOptions = {
        redirect: 'manual',
        cache: 'no-store',
        signal,
        headers: {
          accept: api ? 'application/vnd.github+json' : 'application/octet-stream',
          'user-agent': 'fnos-clash-manager',
          ...headers,
        },
      };
      let response;
      try {
        response = await this.fetcher(target, requestOptions);
        if (target !== current && ([403, 404, 429].includes(response.status) || response.status >= 500)) {
          await response.body?.cancel();
          response = await this.fetcher(current, requestOptions);
        }
      } catch (error) {
        if (target === current) throw error;
        response = await this.fetcher(current, requestOptions);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) fail('下载重定向缺少目标地址');
        current = this.unmirror(new URL(location, current).href);
        continue;
      }
      if (response.status === 403 || response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        const wait = Number.isFinite(reset) && reset > this.now() ? Math.ceil((reset - this.now()) / 60000) : 0;
        await response.body?.cancel();
        fail(`GitHub 请求已限流${wait ? `，约 ${wait} 分钟后再试` : '，请稍后再试'}`, 503);
      }
      if (!response.ok) {
        await response.body?.cancel();
        fail(`GitHub 请求失败：HTTP ${response.status}`, response.status === 404 ? 404 : 502);
      }
      return response;
    }
    fail('下载重定向次数过多');
  }

  async bytes(response) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_API_BODY) fail('版本来源返回的数据过大');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  fallbackEntry(channel, { tag, version, arch, name, build }) {
    return {
      id: `${channel.id}-${version ? `v${version}` : build}-${arch}`,
      channel: channel.id,
      channelLabel: channel.label,
      version: version ? `v${version}` : '',
      build: build || '',
      tag,
      arch,
      name,
      url: `${DOWNLOAD}/${channel.repository}/releases/download/${tag}/${name}`,
      sha256: '',
      size: null,
      verified: false,
      fallback: true,
      prerelease: Boolean(channel.tag),
      risk: channel.risk,
      source: channel.source,
      repository: channel.repository,
      license: channel.license,
      publishedAt: '',
    };
  }

  async fallbackCatalog(channelId) {
    const channel = channelConfig(channelId);
    const archToken = { x86_64: 'amd64', arm64: 'arm64' };
    if (channel.tag) {
      const response = await this.request(`${DOWNLOAD}/${channel.repository}/releases/expanded_assets/${channel.tag}`, channel, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
      const html = (await this.bytes(response)).toString('utf8');
      const suffix = channel.id === 'smart' ? 'alpha-smart' : 'alpha';
      const entries = [];
      for (const [arch, token] of Object.entries(archToken)) {
        const pattern = new RegExp(`mihomo-linux-${token}-${suffix}-([0-9a-f]{7,40})\\.gz`, 'g');
        const match = pattern.exec(html);
        if (!match) continue;
        const name = match[0];
        entries.push(this.fallbackEntry(channel, { tag: channel.tag, version: '', arch, name, build: match[1] }));
      }
      if (!entries.length) fail('备用版本来源未找到可用资产', 404);
      return { channel: channelId, entries, fallback: true };
    }
    const response = await this.request(`${DOWNLOAD}/${channel.repository}/releases.atom`, channel, { headers: { accept: 'application/atom+xml' }, signal: AbortSignal.timeout(15000) });
    const atom = (await this.bytes(response)).toString('utf8');
    const tags = [...atom.matchAll(/<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g)]
      .map(match => match[1])
      .filter(tag => /^v\d+\.\d+\.\d+$/.test(tag))
      .sort((left, right) => compareVersions(left.slice(1), right.slice(1)));
    const selected = [...new Set(tags)].slice(0, 3);
    const entries = [];
    for (const tag of selected) {
      const version = tag.slice(1);
      for (const [arch, token] of Object.entries(archToken)) {
        entries.push(this.fallbackEntry(channel, { tag, version, arch, name: `mihomo-linux-${token}-${tag}.gz` }));
      }
    }
    if (!entries.length) fail('备用版本来源未找到稳定版本', 404);
    return { channel: channelId, entries, fallback: true };
  }

  async catalog(channelId) {
    const channel = channelConfig(channelId);
    const url = channel.tag
      ? `${API}/repos/${channel.repository}/releases/tags/${channel.tag}`
      : `${API}/repos/${channel.repository}/releases?per_page=30`;
    let apiError;
    try {
      const response = await this.request(url, channel, { api: true, signal: AbortSignal.timeout(15000) });
      const payload = JSON.parse((await this.bytes(response)).toString('utf8'));
      const releases = Array.isArray(payload) ? payload : [payload];
      const entries = releases.flatMap(release => parseRelease(release, channelId));
      if (!entries.length) fail('该渠道没有找到当前架构可安装的版本，请稍后再试', 404);
      return this.sortedCatalog(channelId, entries, false);
    } catch (error) {
      apiError = error;
      this.lastError = error;
    }
    try {
      return this.sortedCatalog(channelId, (await this.fallbackCatalog(channelId)).entries, true);
    } catch {
      if (apiError instanceof AppError) throw apiError;
      fail(`版本查询失败：${apiError?.message || '未知错误'}`, 502);
    }
  }

  sortedCatalog(channelId, entries, fallback) {
    const byArch = { x86_64: [], arm64: [] };
    for (const entry of entries) byArch[entry.arch]?.push(entry);
    for (const arch of Object.keys(byArch)) {
      byArch[arch].sort((left, right) => {
        if (left.version && right.version) return compareVersions(left.version.slice(1), right.version.slice(1));
        return String(right.build).localeCompare(String(left.build));
      });
    }
    return { channel: channelId, fallback, entries: [...byArch.x86_64.slice(0, 3), ...byArch.arm64.slice(0, 3)] };
  }

  async download(entry, destination, options = {}) {
    const channel = channelConfig(entry.channel);
    if (entry.repository !== channel.repository || !['x86_64', 'arm64'].includes(entry.arch)) fail('下载元数据与渠道不匹配');
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || '') || !Number.isSafeInteger(entry.size) || entry.size <= 0) fail('该版本没有可信的 SHA256，暂不支持安装');
    if (!this.allowed(entry.url, channel)) fail('版本下载地址不在允许名单中');
    await downloadVerified({
      url: entry.url,
      destination,
      sha256: entry.sha256,
      size: entry.size,
      request: (url, requestOptions) => this.request(url, channel, requestOptions),
      ...options,
    });
  }

  /** Fallback for entries discovered without a GitHub API checksum. Returns the computed hash. */
  async downloadUnverified(entry, destination, options = {}) {
    const channel = channelConfig(entry.channel);
    if (entry.repository !== channel.repository || !['x86_64', 'arm64'].includes(entry.arch)) fail('下载元数据与渠道不匹配');
    if (!this.allowed(entry.url, channel)) fail('版本下载地址不在允许名单中');
    return downloadUnverified({
      url: entry.url,
      destination,
      request: (url, requestOptions) => this.request(url, channel, requestOptions),
      ...options,
    });
  }
}
