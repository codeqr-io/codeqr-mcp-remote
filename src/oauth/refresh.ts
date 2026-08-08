/**
 * Transparent renewal of the CodeQR credentials behind an MCP session.
 *
 * A CodeQR access token lasts 7 days; the session above it lasts 120. Bridging
 * that gap is this module's whole job, and it has to do so without ever
 * presenting a spent refresh token — CodeQR reads that as theft and revokes the
 * user's entire token family (RFC 9700 reuse detection).
 *
 * Correctness rests on two things, in this order:
 *   - a lock, so only one caller rotates a session at a time
 *   - a re-read inside that lock, so a caller that waited does not send the
 *     refresh token the previous holder just spent
 *
 * The in-flight map on top of them is a latency optimisation, not a safety
 * mechanism: removing it keeps the behaviour correct and makes concurrent calls
 * wait out a poll interval instead of resolving immediately.
 */

import {
  acquireRefreshLock,
  releaseRefreshLock,
  updateAccessTokenCredentials,
  validateAccessToken,
  type AccessToken,
  type CodeQRCredentials,
} from './store.js';
import { needsRefresh, refreshCredentials } from './codeqr-oauth.js';

/** Give up waiting on another refresher after this long. */
const WAIT_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 250;

// Collapses concurrent refreshes of the same session within this instance.
// Serverless keeps instances warm across requests, so this is the common case
// and it is worth resolving before reaching for Redis.
const inFlight = new Map<string, Promise<CodeQRCredentials>>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the CodeQR token to use for this request, renewing it if it is close
 * to expiring.
 *
 * Sessions created before the OAuth broker carry a personal API key instead of
 * a credential pair. Those never expire, so they are returned untouched.
 */
export async function resolveCodeQRToken(entry: AccessToken): Promise<string> {
  if (!entry.codeqr) {
    if (!entry.codeqrApiKey) {
      throw new Error('Session carries neither CodeQR credentials nor an API key');
    }
    return entry.codeqrApiKey;
  }

  if (!needsRefresh(entry.codeqr)) {
    return entry.codeqr.accessToken;
  }

  const existing = inFlight.get(entry.token);
  if (existing) {
    return (await existing).accessToken;
  }

  const refresh = renewSerialized(entry).finally(() => {
    inFlight.delete(entry.token);
  });
  inFlight.set(entry.token, refresh);

  return (await refresh).accessToken;
}

/**
 * Renew under a cross-instance lock, or wait for whoever holds it.
 */
async function renewSerialized(entry: AccessToken): Promise<CodeQRCredentials> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await acquireRefreshLock(entry.token)) {
      try {
        // Re-read inside the lock: another instance may have finished renewing
        // between our expiry check and our acquiring the lock, and reusing the
        // refresh token we already read would be the exact fatal case.
        const current = await validateAccessToken(entry.token);
        const credentials = current?.codeqr ?? entry.codeqr!;

        if (!needsRefresh(credentials)) {
          return credentials;
        }

        const renewed = await refreshCredentials(credentials.refreshToken);
        await updateAccessTokenCredentials(entry.token, renewed);
        return renewed;
      } finally {
        await releaseRefreshLock(entry.token);
      }
    }

    await sleep(POLL_INTERVAL_MS);

    // Someone else holds the lock; adopt their result as soon as it lands.
    const current = await validateAccessToken(entry.token);
    if (current?.codeqr && !needsRefresh(current.codeqr)) {
      return current.codeqr;
    }
  }

  throw new Error('Timed out waiting for the CodeQR access token to be renewed');
}
