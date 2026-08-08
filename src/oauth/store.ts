/**
 * OAuth 2.0 state store.
 *
 * Uses Upstash Redis (REST) when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 * are set — ideal for Vercel and other serverless environments.
 * Falls back to in-memory Maps when Redis is not configured (local development).
 */

import { Redis } from '@upstash/redis';
import { nanoid } from 'nanoid';

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * The CodeQR-side credentials a session is built on.
 *
 * `accessToken` is a CodeQR OAuth access token, which lives in the same
 * `restrictedToken` table as a personal API key and is therefore accepted by
 * the API in exactly the same way. It expires after 7 days and is renewed with
 * `refreshToken` (valid for 120 days) without the user seeing anything.
 */
export interface CodeQRCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which `accessToken` stops being accepted by the CodeQR API. */
  expiresAt: number;
}

export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  codeqr: CodeQRCredentials;
  scope: string;
  expiresAt: number;
}

export interface AccessToken {
  token: string;
  clientId: string;
  /**
   * Legacy field: the personal API key pasted into the old authorize form.
   * Sessions created before the OAuth broker still carry one, and they keep
   * working — a personal key does not expire, so they need no refresh. New
   * sessions leave this unset and populate `codeqr` instead.
   */
  codeqrApiKey?: string;
  codeqr?: CodeQRCredentials;
  scope: string;
  expiresAt: number;
}

export interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

/**
 * A handoff parked while the user is over on CodeQR approving the request.
 *
 * The `state` CodeQR echoes back is the key to this record, which is what lets
 * the callback rebuild the ChatGPT side of the exchange. The client's own
 * `state` is carried inside rather than forwarded, so a response that arrives
 * with someone else's state cannot be steered into this session.
 */
export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  clientState?: string;
  scope: string;
  expiresAt: number;
}

// ── Redis client (lazy singleton) ──────────────────────────────────────────────

let redisClient: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    redisClient = new Redis({ url, token });
    return redisClient;
  }

  redisClient = null;
  return null;
}

// Key prefixes: "as" = Application Server (MCP Remote), avoids conflicts with other CodeQR apps
// in the same Upstash account.
const KEY_AUTH_CODE = 'codeqr:as:mcp:oauth:code:';
const KEY_ACCESS_TOKEN = 'codeqr:as:mcp:oauth:token:';
const KEY_CLIENT = 'codeqr:as:mcp:oauth:client:';
const KEY_PENDING = 'codeqr:as:mcp:oauth:pending:';
const KEY_REFRESH_LOCK = 'codeqr:as:mcp:oauth:refresh-lock:';

// Authorization codes expire after 10 minutes (seconds for Redis EX).
const AUTH_CODE_TTL_SEC = 10 * 60;

// How long the user has to finish approving on CodeQR before the handoff is
// dropped. Generous because this window includes logging in and, for a new
// visitor, creating a project.
const PENDING_TTL_SEC = 30 * 60;

// Long enough to cover a slow token call, short enough that a crashed refresh
// does not strand the session for more than a few seconds.
const REFRESH_LOCK_TTL_SEC = 15;

// ── In-memory fallback ─────────────────────────────────────────────────────────

const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, AccessToken>();
const registeredClients = new Map<string, RegisteredClient>();
const pendingAuthorizations = new Map<string, PendingAuthorization>();
const refreshLocks = new Map<string, number>();

// TTL cleanup for in-memory mode (every 5 minutes).
// unref'd so this timer never by itself keeps the process alive.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, code] of authorizationCodes) {
    if (code.expiresAt < now) authorizationCodes.delete(key);
  }
  for (const [key, token] of accessTokens) {
    if (token.expiresAt < now) accessTokens.delete(key);
  }
  for (const [key, pending] of pendingAuthorizations) {
    if (pending.expiresAt < now) pendingAuthorizations.delete(key);
  }
  for (const [key, expiresAt] of refreshLocks) {
    if (expiresAt < now) refreshLocks.delete(key);
  }
}, 5 * 60 * 1000);

cleanupTimer.unref?.();

// Upstash decodes JSON payloads on read, so `get` hands back an object where a
// string went in. Both shapes have to be accepted or the first read throws.
function decode<T>(raw: unknown): T {
  return typeof raw === 'string' ? (JSON.parse(raw) as T) : (raw as T);
}

// ── Authorization Codes ────────────────────────────────────────────────────────

export async function createAuthorizationCode(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  codeqr: CodeQRCredentials;
  scope: string;
}): Promise<string> {
  const code = nanoid(48);
  const entry: AuthorizationCode = {
    code,
    ...params,
    expiresAt: Date.now() + AUTH_CODE_TTL_SEC * 1000,
  };

  const redis = getRedis();
  if (redis) {
    await redis.set(`${KEY_AUTH_CODE}${code}`, JSON.stringify(entry), {
      ex: AUTH_CODE_TTL_SEC,
    });
    return code;
  }

  authorizationCodes.set(code, entry);
  return code;
}

export async function consumeAuthorizationCode(code: string): Promise<AuthorizationCode | null> {
  const redis = getRedis();
  if (redis) {
    // Atomic read + delete so the code cannot be reused (GETDEL).
    const raw = await redis.getdel(`${KEY_AUTH_CODE}${code}`);
    if (raw == null) return null;
    const entry = decode<AuthorizationCode>(raw);
    if (entry.expiresAt < Date.now()) return null;
    return entry;
  }

  const entry = authorizationCodes.get(code) ?? null;
  if (!entry) return null;
  authorizationCodes.delete(code);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

// ── Access Tokens ──────────────────────────────────────────────────────────────

/**
 * Lifetime of the token this server hands to the MCP client.
 *
 * Deliberately tied to CodeQR's refresh-token lifetime (120 days) rather than
 * to its access token (7 days). The access token underneath is rotated for the
 * user, so expiring this one weekly would force a re-authorization that nothing
 * actually requires. When the refresh token does die, the next call fails and
 * the client walks the user through authorizing again.
 */
const ACCESS_TOKEN_TTL_SEC = 120 * 24 * 60 * 60;

export async function createAccessToken(params: {
  clientId: string;
  codeqr: CodeQRCredentials;
  scope: string;
}): Promise<{ token: string; expiresIn: number }> {
  const token = `cqr_mcp_${nanoid(64)}`;
  const expiresIn = ACCESS_TOKEN_TTL_SEC;
  const entry: AccessToken = {
    token,
    ...params,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  const redis = getRedis();
  if (redis) {
    await redis.set(`${KEY_ACCESS_TOKEN}${token}`, JSON.stringify(entry), {
      ex: expiresIn,
    });
    return { token, expiresIn };
  }

  accessTokens.set(token, entry);
  return { token, expiresIn };
}

/**
 * Persist a rotated CodeQR credential pair against an existing session.
 *
 * The remaining TTL is recomputed from `expiresAt` instead of being reset, so
 * that renewing the CodeQR token underneath never silently extends the life of
 * the session above it.
 */
export async function updateAccessTokenCredentials(
  token: string,
  codeqr: CodeQRCredentials,
): Promise<void> {
  const redis = getRedis();

  if (redis) {
    const raw = await redis.get(`${KEY_ACCESS_TOKEN}${token}`);
    if (raw == null) return;

    const entry = decode<AccessToken>(raw);
    const remainingSec = Math.floor((entry.expiresAt - Date.now()) / 1000);
    if (remainingSec <= 0) return;

    await redis.set(
      `${KEY_ACCESS_TOKEN}${token}`,
      JSON.stringify({ ...entry, codeqr, codeqrApiKey: undefined }),
      { ex: remainingSec },
    );
    return;
  }

  const entry = accessTokens.get(token);
  if (!entry) return;
  accessTokens.set(token, { ...entry, codeqr, codeqrApiKey: undefined });
}

export async function validateAccessToken(token: string): Promise<AccessToken | null> {
  const redis = getRedis();
  if (redis) {
    const raw = await redis.get(`${KEY_ACCESS_TOKEN}${token}`);
    if (raw == null) return null;
    const entry = decode<AccessToken>(raw);
    if (entry.expiresAt < Date.now()) {
      await redis.del(`${KEY_ACCESS_TOKEN}${token}`);
      return null;
    }
    return entry;
  }

  const entry = accessTokens.get(token) ?? null;
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    accessTokens.delete(token);
    return null;
  }
  return entry;
}

// ── Dynamic Client Registration ────────────────────────────────────────────────

// Registered OAuth clients are long-lived; no TTL in Redis (manual cleanup if needed).
export async function registerClient(params: {
  clientName: string;
  redirectUris: string[];
}): Promise<RegisteredClient> {
  const clientId = `codeqr_${nanoid(32)}`;
  const client: RegisteredClient = {
    clientId,
    ...params,
    createdAt: Date.now(),
  };

  const redis = getRedis();
  if (redis) {
    await redis.set(`${KEY_CLIENT}${clientId}`, JSON.stringify(client));
  } else {
    registeredClients.set(clientId, client);
  }

  return client;
}

export async function getRegisteredClient(clientId: string): Promise<RegisteredClient | null> {
  const redis = getRedis();
  if (redis) {
    const raw = await redis.get(`${KEY_CLIENT}${clientId}`);
    if (raw == null) return null;
    return decode<RegisteredClient>(raw);
  }

  return registeredClients.get(clientId) ?? null;
}

// ── Pending authorizations (handoff to CodeQR) ────────────────────────────────

export async function createPendingAuthorization(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  clientState?: string;
  scope: string;
}): Promise<string> {
  const state = nanoid(48);
  const entry: PendingAuthorization = {
    ...params,
    expiresAt: Date.now() + PENDING_TTL_SEC * 1000,
  };

  const redis = getRedis();
  if (redis) {
    await redis.set(`${KEY_PENDING}${state}`, JSON.stringify(entry), { ex: PENDING_TTL_SEC });
    return state;
  }

  pendingAuthorizations.set(state, entry);
  return state;
}

export async function consumePendingAuthorization(
  state: string,
): Promise<PendingAuthorization | null> {
  const redis = getRedis();
  if (redis) {
    // GETDEL: a state value is good for exactly one callback.
    const raw = await redis.getdel(`${KEY_PENDING}${state}`);
    if (raw == null) return null;
    const entry = decode<PendingAuthorization>(raw);
    if (entry.expiresAt < Date.now()) return null;
    return entry;
  }

  const entry = pendingAuthorizations.get(state) ?? null;
  if (!entry) return null;
  pendingAuthorizations.delete(state);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

// ── Refresh lock ──────────────────────────────────────────────────────────────

/**
 * Serialize refreshes of a single session across server instances.
 *
 * CodeQR implements RFC 9700 reuse detection: presenting a refresh token that
 * has already been spent is read as theft and revokes the entire token family,
 * which would log the user out for real. An MCP client issuing tool calls in
 * parallel would otherwise trip exactly that, so only one caller is allowed to
 * rotate a given session at a time and the rest wait for the result.
 */
export async function acquireRefreshLock(token: string): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    const result = await redis.set(`${KEY_REFRESH_LOCK}${token}`, '1', {
      nx: true,
      ex: REFRESH_LOCK_TTL_SEC,
    });
    return result === 'OK';
  }

  const existing = refreshLocks.get(token);
  if (existing && existing > Date.now()) return false;
  refreshLocks.set(token, Date.now() + REFRESH_LOCK_TTL_SEC * 1000);
  return true;
}

export async function releaseRefreshLock(token: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.del(`${KEY_REFRESH_LOCK}${token}`);
    return;
  }

  refreshLocks.delete(token);
}
