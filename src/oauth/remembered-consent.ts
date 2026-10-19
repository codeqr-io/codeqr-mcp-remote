/**
 * Lets a browser that approved the verified client on the consent screen skip
 * that screen when the same client asks again, as ChatGPT does on every
 * reconnection.
 *
 * Only a connection that completed is remembered: pressing Continue marks the
 * pending authorization, and the record is written when CodeQR returns a code.
 * A refusal on CodeQR, or a return without a code, forgets whatever this
 * browser remembered, so the screen comes back.
 *
 * Skipping is safe here because nothing the screen guarded is skipped with it:
 * the authorization still goes through approveAuthorization, so the callback
 * only completes in the browser holding the consent binding; state, PKCE and
 * redirect_uri are still the client's own and are checked as before; and only
 * the exact verified callback is remembered, whose name and destination the
 * screen shows the same way to everyone.
 *
 * What it gives up: the screen was also a chance to notice "I did not start
 * this". A link carrying the verified client's own parameters, sent by someone
 * else, now goes straight to CodeQR in a browser that remembers. What stops it
 * there is CodeQR's screen, which asks for a project and an Authorize click
 * (not pinned by any test in this repo), and the verified client's own state
 * check, which this server cannot see.
 */

import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { CODEQR_OAUTH_SCOPES } from '../config.js';
import { logEvent } from '../telemetry.js';
import { COOKIE_TOKEN_LENGTH, readCookieToken } from './browser-binding.js';
import {
  forgetRememberedConsent,
  getRememberedConsent,
  REMEMBERED_CONSENT_TTL_SEC,
  saveRememberedConsent,
} from './store.js';
import { findVerifiedClient } from './verified-clients.js';

export const REMEMBER_COOKIE = '__Host-codeqr_mcp_remember';

export interface ConsentRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
}

const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

// Remembering is a convenience on top of a connection that already worked: a
// store outage costs the user the screen once more, never the redirect.
function reportStoreFailure(operation: 'save' | 'forget' | 'read'): void {
  logEvent('oauth.consent', { outcome: 'error', reason: `remember_${operation}_failed` });
}

export function canRemember(redirectUri: string): boolean {
  return findVerifiedClient(redirectUri) !== undefined;
}

/** Changes whenever the access asked of the user changes, which voids what they approved. */
export function scopeVersion(scope: string, codeqrScopes: readonly string[] = CODEQR_OAUTH_SCOPES): string {
  return createHash('sha256').update(JSON.stringify([scope, codeqrScopes])).digest('base64url');
}

/**
 * Records a completed connection to a verified client. A fresh id every time,
 * so the value in a cookie is always one this server chose.
 */
export async function rememberApproval(req: Request, res: Response, request: ConsentRequest): Promise<void> {
  if (!canRemember(request.redirectUri)) return;

  const previous = readCookieToken(req, REMEMBER_COOKIE);
  const id = nanoid(COOKIE_TOKEN_LENGTH);

  try {
    await saveRememberedConsent(id, {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scopeVersion: scopeVersion(request.scope),
    });
  } catch {
    reportStoreFailure('save');
    return;
  }

  res.cookie(REMEMBER_COOKIE, id, { ...COOKIE_OPTIONS, maxAge: REMEMBERED_CONSENT_TTL_SEC * 1000 });

  if (previous) {
    try {
      await forgetRememberedConsent(previous);
    } catch {
      // The old record is unreachable once its cookie is replaced; it expires on its own.
      reportStoreFailure('forget');
    }
  }
}

export async function forgetApproval(req: Request, res: Response): Promise<void> {
  const id = readCookieToken(req, REMEMBER_COOKIE);
  if (!id) return;

  // Without the cookie the record is unreachable, so clearing it is enough to forget.
  res.clearCookie(REMEMBER_COOKIE, COOKIE_OPTIONS);
  try {
    await forgetRememberedConsent(id);
  } catch {
    reportStoreFailure('forget');
  }
}

export async function isRemembered(req: Request, request: ConsentRequest): Promise<boolean> {
  // Checked again on the way in: a URI dropped from the verified list must
  // bring its screen back, whatever was remembered for it.
  if (!canRemember(request.redirectUri)) return false;

  const id = readCookieToken(req, REMEMBER_COOKIE);
  if (!id) return false;

  let remembered: Awaited<ReturnType<typeof getRememberedConsent>>;
  try {
    remembered = await getRememberedConsent(id);
  } catch {
    reportStoreFailure('read');
    return false;
  }
  return (
    remembered !== null &&
    remembered.clientId === request.clientId &&
    remembered.redirectUri === request.redirectUri &&
    remembered.scopeVersion === scopeVersion(request.scope)
  );
}
