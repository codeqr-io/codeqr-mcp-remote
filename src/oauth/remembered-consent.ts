/**
 * Lets a browser that approved the verified client on the consent screen skip
 * that screen when the same client asks again, as ChatGPT does on every
 * reconnection.
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
  client: { clientId: string };
  redirectUri: string;
  scope: string;
}

/** Changes whenever the access asked of the user changes, which voids what they approved. */
export function scopeVersion(scope: string, codeqrScopes: readonly string[] = CODEQR_OAUTH_SCOPES): string {
  return createHash('sha256').update(JSON.stringify([scope, codeqrScopes])).digest('base64url');
}

/**
 * Records an approval of a verified client. A fresh id every time, so the
 * value in a cookie is always one this server chose.
 */
export async function rememberApproval(req: Request, res: Response, request: ConsentRequest): Promise<void> {
  if (!findVerifiedClient(request.redirectUri)) return;

  const previous = readCookieToken(req, REMEMBER_COOKIE);
  const id = nanoid(COOKIE_TOKEN_LENGTH);

  await saveRememberedConsent(id, {
    clientId: request.client.clientId,
    redirectUri: request.redirectUri,
    scopeVersion: scopeVersion(request.scope),
  });
  if (previous) await forgetRememberedConsent(previous);

  res.cookie(REMEMBER_COOKIE, id, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: REMEMBERED_CONSENT_TTL_SEC * 1000,
  });
}

export async function isRemembered(req: Request, request: ConsentRequest): Promise<boolean> {
  // Checked again on the way in: a URI dropped from the verified list must
  // bring its screen back, whatever was remembered for it.
  if (!findVerifiedClient(request.redirectUri)) return false;

  const id = readCookieToken(req, REMEMBER_COOKIE);
  if (!id) return false;

  const remembered = await getRememberedConsent(id);
  return (
    remembered !== null &&
    remembered.clientId === request.client.clientId &&
    remembered.redirectUri === request.redirectUri &&
    remembered.scopeVersion === scopeVersion(request.scope)
  );
}
