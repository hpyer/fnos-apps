const SECRET_FIELD = /^(\s*(?:secret|password|token|authorization|private-key|uuid|cipher|auth)\s*[:=]\s*).+$/gim;
const QUERY_SECRET = /([?&](?:token|access_token|password|secret|key)=)[^&\s"']+/gi;
const BASIC_AUTH = /(https?:\/\/[^\s"'/:@]+:)[^\s"'@/]+(@)/g;

/** Remove secrets from anything written to a log, API response or error message. */
export function redact(text, secrets = []) {
  let value = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) value = value.split(secret).join('***');
  }
  return value.replace(SECRET_FIELD, '$1***').replace(QUERY_SECRET, '$1***').replace(BASIC_AUTH, '$1***$2');
}

/** Keep origin and path so the user can recognise a subscription, mask its query. */
export function maskUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return '***';
    return `${url.origin}${url.pathname}${url.search || url.hash ? '?***' : ''}`;
  } catch {
    return '***';
  }
}

/** Mask credentials embedded in a diff or preview while keeping the rest readable. */
export function maskCredentials(text) {
  return redact(text);
}
