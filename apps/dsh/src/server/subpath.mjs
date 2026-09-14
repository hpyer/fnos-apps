// URL adaptation is deliberately limited to resource URLs, never arbitrary JS,
// JSON, prompts, file paths or streamed response bodies.
export function prefixPath(value, base) {
  return value.startsWith('/') && !value.startsWith('//') && value !== base && !value.startsWith(`${base}/`)
    ? base + value : value;
}

export function rewriteCss(source, base) {
  return source.replace(/(url\(\s*["']?)(\/(?!\/)[^\s)'"\\]*)(["']?\s*\))/gi,
    (_, before, url, after) => before + prefixPath(url, base) + after)
    .replace(/(@import\s+["'])(\/(?!\/)[^"'\\]*)(["'])/gi,
      (_, before, url, after) => before + prefixPath(url, base) + after);
}

export function rewriteHtml(source, base) {
  // Leave script bodies untouched. Runtime-created URLs are handled by the
  // browser adapter, including classic plugin bundles returned in boot JSON.
  return source.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<[^>]+>/gi, tag => {
    if (/^<style\b/i.test(tag)) return rewriteCss(tag, base);
    const end = tag.indexOf('>') + 1;
    return tag.slice(0, end).replace(/(\s(?:src|href|action|poster)\s*=\s*)(["'])(\/[^"']*)\2/gi,
      (_, before, quote, url) => before + quote + prefixPath(url, base) + quote) + tag.slice(end);
  });
}

export function rewriteResponseHeaders(headers, base, address) {
  const result = { ...headers, 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
  // NAS authentication stays at the gateway. Upstream auth is held server-side.
  delete result['set-cookie'];
  if (result.location) {
    const target = new URL(result.location, address);
    if (target.origin === address.origin) result.location = prefixPath(target.pathname, base) + target.search + target.hash;
    else result.location = prefixPath(result.location, base);
  }
  return result;
}
