import { findVerifiedClient } from './verified-clients.js';

/**
 * The client named to CodeQR as `mcp_client`, for signup attribution only.
 *
 * Unlike the consent screen this vouches for no one: a client is labelled by
 * where its redirect URI points, so another app on chatgpt.com still counts as
 * ChatGPT. Anything unrecognised is `other` rather than its host, so a
 * self-registered client cannot write its own text into a CodeQR signup; the
 * host itself is in the `oauth.*` logs.
 */
const BY_HOST: Record<string, string> = {
  'chatgpt.com': 'chatgpt',
  'claude.ai': 'claude',
  'claude.com': 'claude',
  'vscode.dev': 'vscode',
  'insiders.vscode.dev': 'vscode',
};

const BY_SCHEME: Record<string, string> = {
  'cursor:': 'cursor',
  'vscode:': 'vscode',
};

// Desktop apps and CLIs (Claude Code, the MCP inspector…) all call back on a
// loopback port, and nothing in the URI tells them apart.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK_CLIENT = 'local';

export const UNKNOWN_MCP_CLIENT = 'other';

/** Every value `mcpClientLabel` can return besides a verified client's id. */
export const MCP_CLIENT_LABELS = [
  ...new Set([...Object.values(BY_HOST), ...Object.values(BY_SCHEME), LOOPBACK_CLIENT, UNKNOWN_MCP_CLIENT]),
];

export function mcpClientLabel(redirectUri: string): string {
  const verified = findVerifiedClient(redirectUri);
  if (verified) return verified.id;

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return UNKNOWN_MCP_CLIENT;
  }

  if (Object.hasOwn(BY_SCHEME, url.protocol)) return BY_SCHEME[url.protocol];
  if (LOOPBACK_HOSTS.has(url.hostname)) return LOOPBACK_CLIENT;
  return Object.hasOwn(BY_HOST, url.hostname) ? BY_HOST[url.hostname] : UNKNOWN_MCP_CLIENT;
}
