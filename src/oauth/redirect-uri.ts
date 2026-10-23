/**
 * Which redirect URIs a dynamically registered client may use.
 *
 * MCP requires HTTPS or loopback. Native clients (Cursor, for one) register a
 * private-use scheme instead, as RFC 8252 §7.1 allows, so those pass too; only
 * schemes a browser would execute, read locally, or send over plain HTTP to
 * another machine are refused.
 */

export const MAX_REDIRECT_URI_LENGTH = 2048;

// WHATWG URL keeps the brackets on an IPv6 hostname.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'ftp:',
  'ws:',
  'wss:',
]);

export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) {
    return false;
  }

  // RFC 6749 §3.1.2: the redirection endpoint MUST NOT include a fragment.
  // Checked on the raw string because `new URL('https://a/#').hash` is empty.
  if (value.includes('#')) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // `https://claude.ai@evil.test/` reads as claude.ai to a person but goes to
  // evil.test, and the consent screen shows the host to that person.
  if (url.username || url.password) return false;

  if (url.protocol === 'https:') return url.hostname !== '';
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
  return !FORBIDDEN_SCHEMES.has(url.protocol);
}

/**
 * Whether a redirect_uri is one the client registered.
 *
 * Exact, except that a loopback redirect ignores the port (RFC 8252 §7.3): a
 * native client such as Claude Code listens on a new ephemeral port every
 * session, so the port it registered is rarely the one it asks for later.
 * Host, path and query still have to match, and localhost is not 127.0.0.1.
 */
export function isRegisteredRedirectUri(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const target = loopbackWithoutPort(requested);
  return target !== undefined && registered.some((uri) => loopbackWithoutPort(uri) === target);
}

function loopbackWithoutPort(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  url.port = '';
  return url.toString();
}
