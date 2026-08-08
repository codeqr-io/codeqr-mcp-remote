/**
 * Client for CodeQR's OAuth 2.0 server.
 *
 * This server is a confidential client of CodeQR: it holds a client secret and
 * never exposes it to the MCP client. The token CodeQR issues here is stored in
 * the same table as a personal API key, so everything downstream — the SDK, the
 * 15 tools — treats it identically and needs no knowledge of OAuth.
 */

import { CODEQR_OAUTH_SCOPES, config, hasCodeQROAuthCredentials } from '../config.js';
import type { CodeQRCredentials } from './store.js';

export class CodeQROAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CodeQROAuthError';
  }
}

/**
 * Renew this many milliseconds before the access token actually expires.
 *
 * A token that is technically still valid when a batch of tool calls starts can
 * expire midway through it; refreshing early keeps that from surfacing as a
 * sporadic 401 the user cannot explain.
 */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

/**
 * Hard ceiling on a token call. Must stay below the refresh lock's TTL so the
 * lock cannot outlive its holder — see oauth/store.ts.
 */
export const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

export function needsRefresh(credentials: CodeQRCredentials, now = Date.now()): boolean {
  return credentials.expiresAt - REFRESH_MARGIN_MS <= now;
}

/**
 * Where the user is sent to log in, pick a project, and approve.
 */
export function buildAuthorizeUrl(params: { redirectUri: string; state: string }): string {
  const url = new URL(`${config.codeqrAppUrl}/oauth/authorize`);

  url.searchParams.set('client_id', config.codeqrOAuthClientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  // CodeQR splits on comma, space, or plus; space is the RFC 6749 separator.
  url.searchParams.set('scope', CODEQR_OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', params.state);

  return url.toString();
}

async function requestToken(body: Record<string, string>): Promise<CodeQRCredentials> {
  if (!hasCodeQROAuthCredentials()) {
    throw new CodeQROAuthError(
      'server_error',
      'This server is missing CODEQR_OAUTH_CLIENT_ID / CODEQR_OAUTH_CLIENT_SECRET',
    );
  }

  let response: Response;
  try {
    response = await fetch(`${config.codeqrAppUrl}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...body,
        client_id: config.codeqrOAuthClientId,
        client_secret: config.codeqrOAuthClientSecret,
      }),
      // Bounded so a hung request cannot outlive the refresh lock held around
      // it. If it could, the lock would expire mid-flight and a second caller
      // would re-present a refresh token that is about to be spent.
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Never surfaced as invalid_grant: the authorization is intact, the call
    // simply did not complete, and the caller must be free to retry.
    throw new CodeQROAuthError(
      'server_error',
      err instanceof Error && err.name === 'TimeoutError'
        ? 'CodeQR did not answer the token request in time'
        : `Could not reach CodeQR to exchange tokens: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }

  // Read as text first: an upstream failure can answer with an HTML error page,
  // and calling .json() on that throws something unrelated to the real cause.
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new CodeQROAuthError(
      typeof payload.error === 'string' ? payload.error : 'invalid_grant',
      typeof payload.error_description === 'string'
        ? payload.error_description
        : `CodeQR rejected the token request (HTTP ${response.status})`,
    );
  }

  const accessToken = payload.access_token;
  const refreshToken = payload.refresh_token;
  const expiresIn = payload.expires_in;

  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new CodeQROAuthError(
      'server_error',
      'CodeQR returned a token response without access_token or refresh_token',
    );
  }

  return {
    accessToken,
    refreshToken,
    // Fall back to CodeQR's documented 7 days if expires_in is ever absent —
    // an over-long guess here would be read as "still valid" and skip refresh.
    expiresAt: Date.now() + (typeof expiresIn === 'number' ? expiresIn : 7 * 24 * 60 * 60) * 1000,
  };
}

export async function exchangeCodeForCredentials(params: {
  code: string;
  redirectUri: string;
}): Promise<CodeQRCredentials> {
  return requestToken({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  });
}

export async function refreshCredentials(refreshToken: string): Promise<CodeQRCredentials> {
  return requestToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}
