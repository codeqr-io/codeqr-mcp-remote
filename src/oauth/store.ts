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
  /**
   * Epoch ms the session was issued. Absent on sessions issued before it was
   * recorded; issuedAt() derives it for those.
   */
  createdAt?: number;
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
  /** The consent cookie of the browser that approved; see browser-binding.ts. */
  browserBinding: string;
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
const KEY_REGISTRATION_RATE = 'codeqr:as:mcp:oauth:register-rate:';

// Authorization codes expire after 10 minutes (seconds for Redis EX).
const AUTH_CODE_TTL_SEC = 10 * 60;

// How long the user has to finish approving on CodeQR before the handoff is
// dropped. Generous because this window includes logging in and, for a new
// visitor, creating a project.
export const PENDING_TTL_SEC = 30 * 60;

// A registration nobody ever completes an authorization with is dropped after
// this long, which bounds what anonymous registration can pile up in Redis.
// One that is used is kept indefinitely (see markClientUsed).
const UNUSED_CLIENT_TTL_SEC = 30 * 24 * 60 * 60;

// Generous on purpose: ChatGPT and Claude register from their own servers, so
// one address can stand for many users connecting at the same time.
export const REGISTRATION_LIMIT = 30;
export const REGISTRATION_WINDOW_SEC = 10 * 60;

// Must exceed TOKEN_REQUEST_TIMEOUT_MS (20s in oauth/codeqr-oauth.ts), which is
// the longest a holder can possibly take. If the lock could expire while a
// refresh is still in flight, a second caller would re-present a refresh token
// that is about to be spent — the exact case the lock exists to prevent.
const REFRESH_LOCK_TTL_SEC = 30;

// ── In-memory fallback ─────────────────────────────────────────────────────────

const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, AccessToken>();
const registeredClients = new Map<string, RegisteredClient>();
const pendingAuthorizations = new Map<string, PendingAuthorization>();
const refreshLocks = new Map<string, number>();
const unusedClientDeadlines = new Map<string, number>();
const registrationCounts = new Map<string, { window: number; count: number }>();

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
  for (const [clientId, deadline] of unusedClientDeadlines) {
    if (deadline < now) {
      unusedClientDeadlines.delete(clientId);
      registeredClients.delete(clientId);
    }
  }
  const window = registrationWindow(now);
  for (const [source, entry] of registrationCounts) {
    if (entry.window !== window) registrationCounts.delete(source);
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
 *
 * CodeQR issues each rotated refresh token with a fresh 120 days (app:
 * app/api/oauth/token/refresh-access-token.ts), so the session is renewed by
 * the same amount whenever the credentials under it are — see
 * updateAccessTokenCredentials.
 */
export const ACCESS_TOKEN_TTL_SEC = 120 * 24 * 60 * 60;

/**
 * Hard ceiling on a session, however often it is renewed. Renewal on use means
 * a leaked bearer would otherwise live for as long as whoever holds it keeps
 * calling; this bounds that, at the cost of one re-authorization a year for
 * people who use the connection all the time.
 */
export const MAX_SESSION_LIFETIME_SEC = 365 * 24 * 60 * 60;

/**
 * The deadline a session gets when its CodeQR credentials are rotated at
 * `now`: another full lifetime, never past the ceiling counted from issue.
 *
 * Sessions issued before `createdAt` was recorded never had their deadline
 * moved, so their issue time is exactly one lifetime before it.
 */
export function issuedAt(entry: Pick<AccessToken, 'expiresAt' | 'createdAt'>): number {
  return entry.createdAt ?? entry.expiresAt - ACCESS_TOKEN_TTL_SEC * 1000;
}

export function renewedExpiry(entry: Pick<AccessToken, 'expiresAt' | 'createdAt'>, now: number): number {
  return Math.min(now + ACCESS_TOKEN_TTL_SEC * 1000, issuedAt(entry) + MAX_SESSION_LIFETIME_SEC * 1000);
}

export async function createAccessToken(params: {
  clientId: string;
  codeqr: CodeQRCredentials;
  scope: string;
}): Promise<{ token: string; expiresIn: number }> {
  const token = `cqr_mcp_${nanoid(64)}`;
  const expiresIn = ACCESS_TOKEN_TTL_SEC;
  const now = Date.now();
  const entry: AccessToken = {
    token,
    ...params,
    expiresAt: now + expiresIn * 1000,
    createdAt: now,
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
 * Persist a rotated CodeQR credential pair against an existing session, and
 * give the session the full lifetime again.
 *
 * A session can only reach this point by presenting a CodeQR refresh token
 * CodeQR just accepted, and that rotation gave the new refresh token another
 * 120 days. Keeping the session on its first deadline would end a connection
 * people use every week on a fixed date, while the grant under it is still
 * valid; revocation is unaffected, since a revoked grant fails the rotation
 * with invalid_grant before this runs. A session already past its deadline is
 * left to expire — this never brings one back.
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
    const now = Date.now();
    if (entry.expiresAt <= now) return;

    const expiresAt = renewedExpiry(entry, now);
    const ex = Math.ceil((expiresAt - now) / 1000);
    if (ex <= 0) return;

    // `xx`: write only if the key still exists. It was set with the session's
    // own TTL, so a session that expired (or was deleted) between the read
    // above and this write is not recreated.
    await redis.set(
      `${KEY_ACCESS_TOKEN}${token}`,
      JSON.stringify({
        ...entry,
        codeqr,
        codeqrApiKey: undefined,
        createdAt: issuedAt(entry),
        expiresAt,
      }),
      { ex, xx: true },
    );
    return;
  }

  const entry = accessTokens.get(token);
  const now = Date.now();
  if (!entry || entry.expiresAt <= now) return;
  accessTokens.set(token, {
    ...entry,
    codeqr,
    codeqrApiKey: undefined,
    createdAt: issuedAt(entry),
    expiresAt: renewedExpiry(entry, now),
  });
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
    await redis.set(`${KEY_CLIENT}${clientId}`, JSON.stringify(client), {
      ex: UNUSED_CLIENT_TTL_SEC,
    });
  } else {
    registeredClients.set(clientId, client);
    unusedClientDeadlines.set(clientId, Date.now() + UNUSED_CLIENT_TTL_SEC * 1000);
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

  const deadline = unusedClientDeadlines.get(clientId);
  if (deadline !== undefined && deadline < Date.now()) {
    unusedClientDeadlines.delete(clientId);
    registeredClients.delete(clientId);
    return null;
  }

  return registeredClients.get(clientId) ?? null;
}

/**
 * Keep a client for good once a user has completed an authorization with it.
 *
 * MCP clients cache their client_id and reuse it when the 120-day token runs
 * out, so a used registration must not expire underneath them.
 */
export async function markClientUsed(clientId: string): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.persist(`${KEY_CLIENT}${clientId}`);
    return;
  }

  unusedClientDeadlines.delete(clientId);
}

// ── Registration rate limit ───────────────────────────────────────────────────

function registrationWindow(now: number): number {
  return Math.floor(now / (REGISTRATION_WINDOW_SEC * 1000));
}

/**
 * Count one registration attempt from `source` (a client IP) and say whether
 * it is still within REGISTRATION_LIMIT for the current fixed window.
 */
export async function allowRegistration(source: string): Promise<boolean> {
  const window = registrationWindow(Date.now());

  const redis = getRedis();
  if (redis) {
    // The window number is part of the key, so a key whose EXPIRE was lost is
    // never read again rather than blocking this source for good.
    const key = `${KEY_REGISTRATION_RATE}${source}:${window}`;
    const [count] = await redis.pipeline().incr(key).expire(key, REGISTRATION_WINDOW_SEC).exec();
    return count <= REGISTRATION_LIMIT;
  }

  const entry = registrationCounts.get(source);
  const count = entry && entry.window === window ? entry.count + 1 : 1;
  registrationCounts.set(source, { window, count });
  return count <= REGISTRATION_LIMIT;
}

// ── Pending authorizations (handoff to CodeQR) ────────────────────────────────

export async function createPendingAuthorization(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  clientState?: string;
  scope: string;
  browserBinding: string;
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
