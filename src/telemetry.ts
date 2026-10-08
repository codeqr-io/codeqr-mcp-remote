/**
 * Funnel events for the path between an MCP client and CodeQR: registration,
 * this server's consent screen, the return from CodeQR, the token the client
 * collects, and every MCP request after that — including the ones refused.
 *
 * Each event is one JSON line on stdout, which Vercel keeps for a day. When
 * AXIOM_TOKEN is set it is also sent to the Axiom dataset the CodeQR app logs
 * to, tagged `service: 'mcp'`, so a connection can be followed from this
 * server into the API calls it made.
 *
 * Fields are a closed list: nothing reaches a log line unless its name is in
 * EVENT_FIELDS, so a token, a code or an e-mail cannot ride in on an object
 * spread. Logging never throws and never delays a response.
 */

import { createHash } from 'node:crypto';
import { findVerifiedClient } from './oauth/verified-clients.js';

export type FunnelEvent =
  | 'oauth.register'
  | 'oauth.consent'
  | 'oauth.callback'
  | 'oauth.token'
  | 'mcp.tools_list'
  | 'mcp.tool_call'
  | 'mcp.rejected';

export interface EventFields {
  outcome?: 'ok' | 'error';
  /** Machine-readable cause of an `error` outcome, or of a rejection. */
  reason?: string;
  /** What the user did on the consent screen. */
  decision?: 'shown' | 'approve' | 'deny';
  /** The client_id this server issued at registration. */
  clientId?: string;
  /** Display name: the verified one when the redirect URI is known, else the self-declared one. */
  client?: string;
  redirectHost?: string;
  /** See keyHashPrefix(). */
  keyHashPrefix?: string;
  tool?: string;
  durationMs?: number;
  status?: number;
  rpcMethod?: string;
  userAgent?: string;
  accept?: string;
  protocolVersion?: string;
  hasSession?: boolean;
}

export const EVENT_FIELDS: ReadonlyArray<keyof EventFields> = [
  'outcome',
  'reason',
  'decision',
  'clientId',
  'client',
  'redirectHost',
  'keyHashPrefix',
  'tool',
  'durationMs',
  'status',
  'rpcMethod',
  'userAgent',
  'accept',
  'protocolVersion',
  'hasSession',
];

export const MAX_FIELD_LENGTH = 200;

/**
 * The CodeQR app stores `RestrictedToken.hashedKey` as the hex SHA-256 of the
 * token and logs its first 12 characters as `keyHashPrefix` on every API call
 * (app: lib/auth/hash-token.ts, lib/auth/build-api-key-auth-log.ts). Logging the
 * same prefix here joins an MCP event to the installation and to the API calls
 * it produced, without ever writing the token.
 */
export const KEY_HASH_PREFIX_LENGTH = 12;

export function keyHashPrefix(codeqrToken: string): string {
  return createHash('sha256').update(codeqrToken).digest('hex').slice(0, KEY_HASH_PREFIX_LENGTH);
}

/** Same rule the consent screen uses to name the app asking for access. */
export function clientLabel(redirectUri: string, clientName: string): string {
  return findVerifiedClient(redirectUri)?.name ?? clientName;
}

export function redirectHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).host || 'none';
  } catch {
    return 'invalid';
  }
}

const AXIOM_INGEST_URL = 'https://api.axiom.co/v1/datasets';
const DEFAULT_AXIOM_DATASET = 'codeqr';
const SEND_TIMEOUT_MS = 2_000;

/**
 * Vercel's request context, read the way `@vercel/functions` reads it
 * (`getContext()` in its get-context.js), to keep the Axiom send alive after
 * the response without adding the package for one call. Outside Vercel the
 * symbol is absent and the send simply runs unattended.
 */
const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

function waitUntil(promise: Promise<unknown>): void {
  const context = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } }>)[
    VERCEL_REQUEST_CONTEXT
  ]?.get?.();
  context?.waitUntil?.(promise);
}

function pick(fields: EventFields): Record<string, string | number | boolean> {
  const picked: Record<string, string | number | boolean> = {};
  for (const name of EVENT_FIELDS) {
    const value = fields[name];
    if (value === undefined || value === null) continue;
    picked[name] = typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : value;
  }
  return picked;
}

async function sendToAxiom(token: string, dataset: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${AXIOM_INGEST_URL}/${encodeURIComponent(dataset)}/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([entry]),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    // The stdout line above is the record of last resort.
  }
}

export function logEvent(event: FunnelEvent, fields: EventFields = {}): void {
  try {
    const entry = { _time: new Date().toISOString(), service: 'mcp', event, ...pick(fields) };
    process.stdout.write(`${JSON.stringify(entry)}\n`);

    const token = process.env.AXIOM_TOKEN;
    if (!token) return;

    const sending = sendToAxiom(token, process.env.AXIOM_DATASET || DEFAULT_AXIOM_DATASET, entry);
    waitUntil(sending);
  } catch {
    // Telemetry must never be the reason a request fails.
  }
}
