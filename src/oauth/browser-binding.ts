/**
 * Ties an authorization to the browser the user approved it in.
 *
 * One random value in a `__Host-` cookie does two jobs: the consent form must
 * echo it back (CSRF), and the pending authorization records it, so the
 * callback only completes in the browser that saw the consent screen. Without
 * the second check, anyone could approve their own request, keep the CodeQR
 * URL it redirects to, and hand that link to a victim — who would then see only
 * CodeQR's own "CodeQR MCP" screen and never learn which app gets the access.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { PENDING_TTL_SEC } from './store.js';

export const BINDING_COOKIE = '__Host-codeqr_mcp_consent';

/** Length of every random value this server keeps in a cookie (nanoid alphabet). */
export const COOKIE_TOKEN_LENGTH = 32;
const COOKIE_TOKEN_FORMAT = /^[A-Za-z0-9_-]+$/;

/** The named cookie's value when it has the shape this server issues, else null. */
export function readCookieToken(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;

    const value = part.slice(eq + 1).trim();
    return value.length === COOKIE_TOKEN_LENGTH && COOKIE_TOKEN_FORMAT.test(value) ? value : null;
  }

  return null;
}

export function readBinding(req: Request): string | null {
  return readCookieToken(req, BINDING_COOKIE);
}

/**
 * Reuses the browser's binding when it has one, so two authorizations running
 * side by side do not invalidate each other, and renews the cookie so it
 * outlives the pending authorization it is about to be recorded in.
 */
export function issueBinding(req: Request, res: Response): string {
  const binding = readBinding(req) ?? nanoid(COOKIE_TOKEN_LENGTH);

  res.cookie(BINDING_COOKIE, binding, {
    httpOnly: true,
    secure: true,
    // Lax still rides the top-level redirect back from app.codeqr.io, but not
    // a form another site posts at the consent endpoint.
    sameSite: 'lax',
    path: '/',
    maxAge: PENDING_TTL_SEC * 1000,
  });

  return binding;
}

export function sameBinding(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
