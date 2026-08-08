/**
 * OAuth 2.0 Authorization Code flow with PKCE.
 *
 * This server sits between the MCP client and CodeQR, and is both:
 *   - the authorization server the MCP client talks to (with DCR + PKCE), and
 *   - a confidential OAuth client of CodeQR.
 *
 * Flow:
 * 1. The client registers dynamically via POST /oauth/register
 * 2. The client sends the user to GET /oauth/authorize
 * 3. This server parks the request and redirects to CodeQR, where the user
 *    logs in, picks which project to grant access to, and approves
 * 4. CodeQR returns the user to GET /oauth/callback, which trades the code for
 *    a CodeQR access + refresh token pair and redirects back to the client
 * 5. The client exchanges its own code for a token via POST /oauth/token
 * 6. The client sends MCP requests with that token; the CodeQR token underneath
 *    is renewed transparently (see middleware/auth.ts)
 *
 * The user never sees or handles an API key.
 */

import { Router, type Request, type Response } from 'express';
import {
  createAuthorizationCode,
  consumeAuthorizationCode,
  createAccessToken,
  createPendingAuthorization,
  consumePendingAuthorization,
  getRegisteredClient,
  registerClient,
} from '../oauth/store.js';
import { verifyCodeChallenge } from '../oauth/pkce.js';
import { buildAuthorizeUrl, exchangeCodeForCredentials } from '../oauth/codeqr-oauth.js';
import { getCallbackUrl, hasCodeQROAuthCredentials } from '../config.js';

export function createOAuthRouter(): Router {
  const router = Router();

  // ── Dynamic Client Registration (RFC 7591) ─────────────────────────────────

  router.post('/register', async (req: Request, res: Response) => {
    const { client_name, redirect_uris } = req.body;

    if (!client_name || !redirect_uris || !Array.isArray(redirect_uris)) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'client_name and redirect_uris are required',
      });
      return;
    }

    const client = await registerClient({
      clientName: client_name,
      redirectUris: redirect_uris,
    });

    res.status(201).json({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
  });

  // ── Authorization Endpoint ─────────────────────────────────────────────────

  router.get('/authorize', async (req: Request, res: Response) => {
    const {
      client_id,
      redirect_uri,
      response_type,
      code_challenge,
      code_challenge_method,
      state,
      scope,
    } = req.query as Record<string, string>;

    if (!client_id || !redirect_uri) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'client_id and redirect_uri are required',
      });
      return;
    }

    // The redirect target is checked against what the client registered before
    // anything is echoed to it. Skipping this would let an attacker who knows a
    // client_id name their own redirect_uri and collect the authorization code.
    const client = await getRegisteredClient(client_id);

    if (!client) {
      res.status(400).json({
        error: 'invalid_client',
        error_description: 'Unknown client_id. Register via POST /oauth/register first.',
      });
      return;
    }

    if (!client.redirectUris.includes(redirect_uri)) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri does not match any URI registered for this client',
      });
      return;
    }

    // From here the redirect_uri is trusted, so failures are reported to the
    // client as OAuth errors rather than as an HTTP page the user is stuck on.
    if (response_type !== 'code') {
      redirectWithError(res, redirect_uri, 'unsupported_response_type', 'Only "code" is supported', state);
      return;
    }

    if (!code_challenge || code_challenge_method !== 'S256') {
      redirectWithError(
        res,
        redirect_uri,
        'invalid_request',
        'PKCE with S256 code_challenge_method is required',
        state,
      );
      return;
    }

    if (!hasCodeQROAuthCredentials()) {
      redirectWithError(
        res,
        redirect_uri,
        'server_error',
        'This MCP server is not configured to authorize against CodeQR',
        state,
      );
      return;
    }

    // Park everything the callback will need. The client's own state travels
    // inside this record instead of over to CodeQR, so a callback carrying
    // someone else's state cannot be replayed into this session.
    const brokerState = await createPendingAuthorization({
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      clientState: state,
      scope: scope || 'mcp:tools',
    });

    res.redirect(
      302,
      buildAuthorizeUrl({ redirectUri: getCallbackUrl(req), state: brokerState }),
    );
  });

  // ── Callback from CodeQR ───────────────────────────────────────────────────

  router.get('/callback', async (req: Request, res: Response) => {
    const { code, state, error, error_description } = req.query as Record<string, string>;

    if (!state) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing state parameter',
      });
      return;
    }

    const pending = await consumePendingAuthorization(state);

    if (!pending) {
      // Also the path taken when the user lets the approval screen sit for half
      // an hour, so it is phrased as something they can act on.
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'This authorization request expired or was already used. Start again.',
      });
      return;
    }

    // The user pressed Refuse, or CodeQR turned the request down. Either way the
    // client is told, per RFC 6749 §4.1.2.1, instead of being left waiting.
    if (error) {
      redirectWithError(
        res,
        pending.redirectUri,
        error,
        error_description || 'Authorization was refused',
        pending.clientState,
      );
      return;
    }

    if (!code) {
      redirectWithError(
        res,
        pending.redirectUri,
        'invalid_request',
        'CodeQR returned no authorization code',
        pending.clientState,
      );
      return;
    }

    let codeqr;
    try {
      codeqr = await exchangeCodeForCredentials({
        code,
        redirectUri: getCallbackUrl(req),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Token exchange with CodeQR failed';
      redirectWithError(res, pending.redirectUri, 'server_error', message, pending.clientState);
      return;
    }

    const authCode = await createAuthorizationCode({
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      codeqr,
      scope: pending.scope,
    });

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set('code', authCode);
    if (pending.clientState) redirectUrl.searchParams.set('state', pending.clientState);

    res.redirect(302, redirectUrl.toString());
  });

  // ── Token Endpoint ─────────────────────────────────────────────────────────

  router.post('/token', async (req: Request, res: Response) => {
    const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body;

    if (grant_type !== 'authorization_code') {
      res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: 'Only authorization_code grant is supported',
      });
      return;
    }

    if (!code || !code_verifier) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'code and code_verifier are required',
      });
      return;
    }

    // Consume the authorization code (one-time use)
    const authCode = await consumeAuthorizationCode(code);

    if (!authCode) {
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid or expired authorization code',
      });
      return;
    }

    // Verify PKCE
    if (!verifyCodeChallenge(code_verifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'PKCE code_verifier verification failed',
      });
      return;
    }

    // Verify client_id and redirect_uri match
    if (authCode.clientId !== client_id || authCode.redirectUri !== redirect_uri) {
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'client_id or redirect_uri mismatch',
      });
      return;
    }

    // Issue an access token backed by the user's CodeQR credentials
    const { token, expiresIn } = await createAccessToken({
      clientId: authCode.clientId,
      codeqr: authCode.codeqr,
      scope: authCode.scope,
    });

    res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: authCode.scope,
    });
  });

  return router;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Hand an OAuth error back to the client at its own redirect_uri.
 *
 * Only ever called with a redirect_uri that has already been matched against
 * the client's registration.
 */
function redirectWithError(
  res: Response,
  redirectUri: string,
  error: string,
  description: string,
  state?: string,
): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);

  res.redirect(302, url.toString());
}
