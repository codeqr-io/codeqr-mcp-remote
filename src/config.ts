/**
 * Server configuration.
 *
 * Environment variables:
 *   PORT                     - HTTP port (default: 3000)
 *   SERVER_URL               - Public URL of this server (e.g., https://mcp.codeqr.io)
 *   STAINLESS_API_KEY        - Optional Stainless API key for code execution sandbox
 *   LOG_LEVEL                - Log level: debug, info, warn, error (default: info)
 *   UPSTASH_REDIS_REST_URL   - Optional; Upstash Redis REST URL (persistent OAuth store)
 *   UPSTASH_REDIS_REST_TOKEN - Optional; Upstash Redis REST token
 *   CODEQR_APP_URL           - CodeQR dashboard origin (default: https://app.codeqr.io)
 *   CODEQR_OAUTH_CLIENT_ID   - client_id of the OAuth app registered in CodeQR
 *   CODEQR_OAUTH_CLIENT_SECRET - its client_secret (this server is a confidential client)
 */

import type { Request } from 'express';

/**
 * This server's version, reported on /health and in the MCP handshake.
 *
 * Declared here rather than imported from package.json so the compiled output
 * layout stays flat, and declared once because it was previously written out
 * in both places — and the MCP handshake had drifted to reporting the
 * `@codeqr/ts` version instead of this one.
 *
 * Keep in step with the `version` field in package.json and in server.json —
 * the registry refuses to republish a version it already has, so a partial
 * bump either fails at publish time or ships a mismatched entry.
 * tests/server-json.test.ts fails when the three drift apart.
 */
export const SERVER_VERSION = '0.1.0';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  serverUrl: process.env.SERVER_URL || '',
  stainlessApiKey: process.env.STAINLESS_API_KEY || '',
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',

  codeqrAppUrl: (process.env.CODEQR_APP_URL || 'https://app.codeqr.io').replace(/\/+$/, ''),
  codeqrOAuthClientId: process.env.CODEQR_OAUTH_CLIENT_ID || '',
  codeqrOAuthClientSecret: process.env.CODEQR_OAUTH_CLIENT_SECRET || '',
};

/**
 * Scopes requested from CodeQR on the user's behalf.
 *
 * `user.read` is appended by CodeQR's own authorize schema, so it is not listed
 * here. Adding a tool that touches a new resource means adding its scope here,
 * and existing authorizations will need to be granted again to pick it up.
 *
 * `conversions.write` is deliberately absent, and its absence is why the
 * track_lead and track_sale tools no longer exist. CodeQR restricts that scope
 * to workspace owners, and its authorize endpoint rejects the *entire* request
 * when any requested scope exceeds the user's role — so asking for it would
 * stop every member from connecting at all, trading every working tool for two.
 * Bringing conversions back means a separate, optional consent step, not an
 * extra entry in this list.
 */
export const CODEQR_OAUTH_SCOPES = [
  'links.read',
  'links.write',
  'qrcodes.read',
  'qrcodes.write',
  'analytics.read',
  'domains.read',
  'tags.read',
  'tags.write',
] as const;

/**
 * True once the CodeQR OAuth app credentials are present.
 *
 * Checked at request time rather than at boot: the server still has to serve
 * /health and the well-known documents when it is misconfigured, so that the
 * failure surfaces as a readable OAuth error instead of a container that will
 * not start.
 */
export function hasCodeQROAuthCredentials(): boolean {
  return Boolean(config.codeqrOAuthClientId && config.codeqrOAuthClientSecret);
}

/**
 * Get the public server URL, using the SERVER_URL env var or inferring from the request.
 */
export function getServerUrl(req: Request): string {
  if (config.serverUrl) return config.serverUrl;

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

/**
 * Where CodeQR sends the user back after they approve or refuse.
 *
 * Must match one of the redirect URIs registered on the CodeQR OAuth app
 * exactly — CodeQR compares the string, so a trailing slash is a mismatch.
 */
export function getCallbackUrl(req: Request): string {
  return `${getServerUrl(req)}/oauth/callback`;
}
