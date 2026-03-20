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

export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  codeqrApiKey: string;
  scope: string;
  expiresAt: number;
}

export interface AccessToken {
  token: string;
  clientId: string;
  codeqrApiKey: string;
  scope: string;
  expiresAt: number;
}

export interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
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

// Authorization codes expire after 10 minutes (seconds for Redis EX).
const AUTH_CODE_TTL_SEC = 10 * 60;

// ── In-memory fallback ─────────────────────────────────────────────────────────

const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, AccessToken>();
const registeredClients = new Map<string, RegisteredClient>();

// TTL cleanup for in-memory mode (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, code] of authorizationCodes) {
    if (code.expiresAt < now) authorizationCodes.delete(key);
  }
  for (const [key, token] of accessTokens) {
    if (token.expiresAt < now) accessTokens.delete(key);
  }
}, 5 * 60 * 1000);

// ── Authorization Codes ────────────────────────────────────────────────────────

export async function createAuthorizationCode(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  codeqrApiKey: string;
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
    const entry =
      typeof raw === 'string' ? (JSON.parse(raw) as AuthorizationCode) : (raw as AuthorizationCode);
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

export async function createAccessToken(params: {
  clientId: string;
  codeqrApiKey: string;
  scope: string;
}): Promise<{ token: string; expiresIn: number }> {
  const token = `cqr_mcp_${nanoid(64)}`;
  const expiresIn = 7 * 24 * 60 * 60; // 7 days in seconds
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

export async function validateAccessToken(token: string): Promise<AccessToken | null> {
  const redis = getRedis();
  if (redis) {
    const raw = await redis.get(`${KEY_ACCESS_TOKEN}${token}`);
    if (raw == null) return null;
    const entry =
      typeof raw === 'string' ? (JSON.parse(raw) as AccessToken) : (raw as AccessToken);
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
    return typeof raw === 'string' ? (JSON.parse(raw) as RegisteredClient) : (raw as RegisteredClient);
  }

  return registeredClients.get(clientId) ?? null;
}
