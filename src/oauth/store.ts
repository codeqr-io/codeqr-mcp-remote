/**
 * In-memory store for OAuth 2.0 state.
 *
 * For production, replace this with Redis, a database, or any persistent store.
 * This implementation works for single-instance deployments.
 */

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

// ── Store ──────────────────────────────────────────────────────────────────────

const authorizationCodes = new Map<string, AuthorizationCode>();
const accessTokens = new Map<string, AccessToken>();
const registeredClients = new Map<string, RegisteredClient>();

// TTL cleanup interval (every 5 minutes)
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

export function createAuthorizationCode(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  codeqrApiKey: string;
  scope: string;
}): string {
  const code = nanoid(48);
  authorizationCodes.set(code, {
    code,
    ...params,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
  });
  return code;
}

export function consumeAuthorizationCode(code: string): AuthorizationCode | null {
  const entry = authorizationCodes.get(code);
  if (!entry) return null;
  authorizationCodes.delete(code); // One-time use
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

// ── Access Tokens ──────────────────────────────────────────────────────────────

export function createAccessToken(params: {
  clientId: string;
  codeqrApiKey: string;
  scope: string;
}): { token: string; expiresIn: number } {
  const token = `cqr_mcp_${nanoid(64)}`;
  const expiresIn = 7 * 24 * 60 * 60; // 7 days in seconds
  accessTokens.set(token, {
    token,
    ...params,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  return { token, expiresIn };
}

export function validateAccessToken(token: string): AccessToken | null {
  const entry = accessTokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    accessTokens.delete(token);
    return null;
  }
  return entry;
}

// ── Dynamic Client Registration ────────────────────────────────────────────────

export function registerClient(params: {
  clientName: string;
  redirectUris: string[];
}): RegisteredClient {
  const clientId = `codeqr_${nanoid(32)}`;
  const client: RegisteredClient = {
    clientId,
    ...params,
    createdAt: Date.now(),
  };
  registeredClients.set(clientId, client);
  return client;
}

export function getRegisteredClient(clientId: string): RegisteredClient | null {
  return registeredClients.get(clientId) ?? null;
}
