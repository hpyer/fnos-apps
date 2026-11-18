const GITHUB_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'gist.github.com',
  'gist.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export function normalizeMirror(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { return ''; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
  return `${url.origin}${url.pathname.replace(/\/?$/, '/')}`;
}

function isGithub(url) {
  try { return GITHUB_HOSTS.has(new URL(url).hostname); } catch { return false; }
}

/** Prefix a GitHub URL with the configured mirror, e.g. https://ghfast.top/https://github.com/... */
export function mirrorGithubUrl(url, mirror) {
  const value = String(url || '');
  const prefix = normalizeMirror(mirror);
  if (!prefix || !isGithub(value) || value.startsWith(prefix)) return value;
  return `${prefix}${value}`;
}

/** Remove a mirror prefix so redirect/source checks keep operating on the original URL. */
export function unmirrorGithubUrl(url, mirror) {
  const value = String(url || '');
  const prefix = normalizeMirror(mirror);
  if (!prefix || !value.startsWith(prefix)) return value;
  const rest = value.slice(prefix.length);
  return isGithub(rest) ? rest : value;
}

export function mirrorFetcher(fetcher, getMirror) {
  return (url, options) => fetcher(mirrorGithubUrl(url, getMirror()), options);
}
