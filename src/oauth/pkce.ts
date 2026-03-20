/**
 * PKCE (Proof Key for Code Exchange) utilities for OAuth 2.0.
 *
 * ChatGPT mandates PKCE with S256 challenge method.
 */

import { createHash } from 'node:crypto';

/**
 * Verify a PKCE code_verifier against a stored code_challenge.
 *
 * For S256: BASE64URL(SHA256(code_verifier)) === code_challenge
 */
export function verifyCodeChallenge(
  codeVerifier: string,
  codeChallenge: string,
  codeChallengeMethod: string,
): boolean {
  if (codeChallengeMethod === 'S256') {
    const hash = createHash('sha256').update(codeVerifier).digest('base64url');
    return hash === codeChallenge;
  }

  if (codeChallengeMethod === 'plain') {
    return codeVerifier === codeChallenge;
  }

  return false;
}
