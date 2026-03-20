/**
 * Server configuration.
 *
 * Environment variables:
 *   PORT                - HTTP port (default: 3000)
 *   SERVER_URL          - Public URL of this server (e.g., https://mcp.codeqr.io)
 *   STAINLESS_API_KEY        - Optional Stainless API key for code execution sandbox
 *   LOG_LEVEL                - Log level: debug, info, warn, error (default: info)
 *   UPSTASH_REDIS_REST_URL   - Optional; Upstash Redis REST URL (persistent OAuth store)
 *   UPSTASH_REDIS_REST_TOKEN - Optional; Upstash Redis REST token
 */

import type { Request } from 'express';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  serverUrl: process.env.SERVER_URL || '',
  stainlessApiKey: process.env.STAINLESS_API_KEY || '',
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
};

/**
 * Get the public server URL, using the SERVER_URL env var or inferring from the request.
 */
export function getServerUrl(req: Request): string {
  if (config.serverUrl) return config.serverUrl;

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
