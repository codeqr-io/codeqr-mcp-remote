/**
 * OAuth 2.0 Authorization Code flow with PKCE.
 *
 * This server sits between the MCP client and CodeQR, and is both:
 *   - the authorization server the MCP client talks to (with DCR + PKCE), and
 *   - a confidential OAuth client of CodeQR.
 *
 * Flow:
 * 1. The client registers dynamically via POST /oauth/register
 * 2. The client sends the user to GET /oauth/authorize, which shows this
 *    server's own consent screen: which app is asking, and where the access
 *    will be sent
 * 3. On approval (POST /oauth/authorize) this server parks the request and
 *    redirects to CodeQR, where the user logs in, picks which project to grant
 *    access to, and approves
 * 4. CodeQR returns the user to GET /oauth/callback, which trades the code for
 *    a CodeQR access + refresh token pair and redirects back to the client
 * 5. The client exchanges its own code for a token via POST /oauth/token
 * 6. The client sends MCP requests with that token; the CodeQR token underneath
 *    is renewed transparently (see middleware/auth.ts)
 *
 * Step 2 is required by the MCP spec for a proxy that talks to its upstream
 * with one static client_id: CodeQR's screen only ever names this server, so
 * without it a user cannot tell a client they started from one a phishing link
 * registered a minute ago.
 *
 * The user never sees or handles an API key.
 */

import { Router, type Request, type Response } from 'express';
import {
  allowRegistration,
  createAuthorizationCode,
  consumeAuthorizationCode,
  createAccessToken,
  createPendingAuthorization,
  consumePendingAuthorization,
  getRegisteredClient,
  markClientUsed,
  registerClient,
  REGISTRATION_WINDOW_SEC,
  type RegisteredClient,
} from '../oauth/store.js';
import { verifyCodeChallenge } from '../oauth/pkce.js';
import { buildAuthorizeUrl, exchangeCodeForCredentials } from '../oauth/codeqr-oauth.js';
import { issueBinding, readBinding, sameBinding } from '../oauth/browser-binding.js';
import { sendConsentPage } from '../oauth/consent-page.js';
import { isAllowedRedirectUri } from '../oauth/redirect-uri.js';
import { CODEQR_OAUTH_SCOPES, getCallbackUrl, hasCodeQROAuthCredentials } from '../config.js';
import { clientLabel, keyHashPrefix, logEvent, redirectHost } from '../telemetry.js';

const MAX_CLIENT_NAME_LENGTH = 200;
const MAX_REDIRECT_URIS = 10;

export function createOAuthRouter(): Router {
  const router = Router();

  // ── Dynamic Client Registration (RFC 7591) ─────────────────────────────────

  router.post('/register', async (req: Request, res: Response) => {
    if (!(await allowRegistration(clientAddress(req)))) {
      logEvent('oauth.register', { outcome: 'error', reason: 'rate_limited' });
      res
        .status(429)
        .set('Retry-After', String(REGISTRATION_WINDOW_SEC))
        .json({
          error: 'temporarily_unavailable',
          error_description: 'Too many client registrations from this address. Try again later.',
        });
      return;
    }

    const { client_name, redirect_uris } = req.body ?? {};

    if (!client_name || !redirect_uris || !Array.isArray(redirect_uris)) {
      logEvent('oauth.register', { outcome: 'error', reason: 'missing_metadata' });
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'client_name and redirect_uris are required',
      });
      return;
    }

    if (
      typeof client_name !== 'string' ||
      client_name.trim() === '' ||
      client_name.length > MAX_CLIENT_NAME_LENGTH
    ) {
      logEvent('oauth.register', { outcome: 'error', reason: 'invalid_client_name' });
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: `client_name must be a non-empty string of at most ${MAX_CLIENT_NAME_LENGTH} characters`,
      });
      return;
    }

    if (
      redirect_uris.length === 0 ||
      redirect_uris.length > MAX_REDIRECT_URIS ||
      !redirect_uris.every(isAllowedRedirectUri)
    ) {
      logEvent('oauth.register', { outcome: 'error', reason: 'invalid_redirect_uri' });
      res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description:
          'Each redirect URI must use HTTPS, loopback HTTP (localhost, 127.0.0.1 or [::1]), ' +
          `or an app-specific scheme, carry no fragment, and there can be at most ${MAX_REDIRECT_URIS}`,
      });
      return;
    }

    const client = await registerClient({
      clientName: client_name,
      redirectUris: redirect_uris,
    });

    logEvent('oauth.register', {
      outcome: 'ok',
      clientId: client.clientId,
      client: clientLabel(client.redirectUris[0] ?? '', client.clientName),
      redirectHost: redirectHost(client.redirectUris[0] ?? ''),
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
    const request = await checkAuthorizeRequest(req.query, res);
    if (!request) return;

    const binding = issueBinding(req, res);

    logEvent('oauth.consent', {
      decision: 'shown',
      clientId: request.client.clientId,
      client: clientLabel(request.redirectUri, request.client.clientName),
    });

    sendConsentPage(res, {
      clientName: request.client.clientName,
      redirectUri: request.redirectUri,
      scopes: CODEQR_OAUTH_SCOPES,
      fields: {
        client_id: request.client.clientId,
        redirect_uri: request.redirectUri,
        response_type: 'code',
        code_challenge: request.codeChallenge,
        code_challenge_method: request.codeChallengeMethod,
        state: request.clientState,
        scope: request.scope,
        csrf_token: binding,
      },
    });
  });

  router.post('/authorize', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Checked before anything else: without it a page on another site could
    // post an approval from the user's browser for a client they never saw.
    const binding = readBinding(req);
    if (!binding || !sameBinding(binding, param(body.csrf_token))) {
      logEvent('oauth.consent', { outcome: 'error', reason: 'binding_mismatch' });
      res.status(403).json({
        error: 'invalid_request',
        error_description: 'This approval could not be verified. Start the connection again from your app.',
      });
      return;
    }

    const request = await checkAuthorizeRequest(body, res);
    if (!request) return;

    const client = clientLabel(request.redirectUri, request.client.clientName);

    if (param(body.decision) !== 'approve') {
      logEvent('oauth.consent', { decision: 'deny', clientId: request.client.clientId, client });
      redirectWithError(
        res,
        request.redirectUri,
        'access_denied',
        'The user declined to connect this app',
        request.clientState,
        303,
      );
      return;
    }

    // Park everything the callback will need. The client's own state travels
    // inside this record instead of over to CodeQR, so a callback carrying
    // someone else's state cannot be replayed into this session.
    const brokerState = await createPendingAuthorization({
      clientId: request.client.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      clientState: request.clientState,
      scope: request.scope,
      browserBinding: issueBinding(req, res),
    });

    logEvent('oauth.consent', { decision: 'approve', clientId: request.client.clientId, client });

    res.redirect(
      303,
      buildAuthorizeUrl({ redirectUri: getCallbackUrl(req), state: brokerState }),
    );
  });

  // ── Callback from CodeQR ───────────────────────────────────────────────────

  router.get('/callback', async (req: Request, res: Response) => {
    const { code, state, error, error_description } = req.query as Record<string, string>;

    if (!state) {
      logEvent('oauth.callback', { outcome: 'error', reason: 'missing_state' });
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Missing state parameter',
      });
      return;
    }

    const pending = await consumePendingAuthorization(state);

    if (!pending) {
      logEvent('oauth.callback', { outcome: 'error', reason: 'expired_or_used' });
      // Also the path taken when the user lets the approval screen sit for half
      // an hour, so it is phrased as something they can act on.
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'This authorization request expired or was already used. Start again.',
      });
      return;
    }

    // A callback landing in a browser other than the one that approved on this
    // server's consent screen is a CodeQR link someone was handed, so it ends
    // here — no code, and nothing sent to the redirect_uri.
    if (!sameBinding(readBinding(req), pending.browserBinding)) {
      logEvent('oauth.callback', { outcome: 'error', reason: 'other_browser', clientId: pending.clientId });
      res.status(400).json({
        error: 'invalid_request',
        error_description:
          'This authorization was not started in this browser. Start the connection again from your app.',
      });
      return;
    }

    // The user pressed Refuse, or CodeQR turned the request down. Either way the
    // client is told, per RFC 6749 §4.1.2.1, instead of being left waiting.
    if (error) {
      logEvent('oauth.callback', {
        outcome: 'error',
        reason: `codeqr_${error}`,
        clientId: pending.clientId,
      });
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
      logEvent('oauth.callback', { outcome: 'error', reason: 'no_code', clientId: pending.clientId });
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
      logEvent('oauth.callback', { outcome: 'error', reason: 'exchange_failed', clientId: pending.clientId });
      const message = err instanceof Error ? err.message : 'Token exchange with CodeQR failed';
      redirectWithError(res, pending.redirectUri, 'server_error', message, pending.clientState);
      return;
    }

    await markClientUsed(pending.clientId);

    const authCode = await createAuthorizationCode({
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      codeqr,
      scope: pending.scope,
    });

    logEvent('oauth.callback', {
      outcome: 'ok',
      clientId: pending.clientId,
      redirectHost: redirectHost(pending.redirectUri),
      keyHashPrefix: keyHashPrefix(codeqr.accessToken),
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
      logEvent('oauth.token', { outcome: 'error', reason: 'unsupported_grant_type' });
      res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: 'Only authorization_code grant is supported',
      });
      return;
    }

    if (!code || !code_verifier) {
      logEvent('oauth.token', { outcome: 'error', reason: 'missing_code_or_verifier' });
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'code and code_verifier are required',
      });
      return;
    }

    // Consume the authorization code (one-time use)
    const authCode = await consumeAuthorizationCode(code);

    if (!authCode) {
      logEvent('oauth.token', { outcome: 'error', reason: 'invalid_or_expired_code' });
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid or expired authorization code',
      });
      return;
    }

    // Verify PKCE
    if (!verifyCodeChallenge(code_verifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
      logEvent('oauth.token', { outcome: 'error', reason: 'pkce_failed', clientId: authCode.clientId });
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'PKCE code_verifier verification failed',
      });
      return;
    }

    // Verify client_id and redirect_uri match
    if (authCode.clientId !== client_id || authCode.redirectUri !== redirect_uri) {
      logEvent('oauth.token', { outcome: 'error', reason: 'client_mismatch', clientId: authCode.clientId });
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

    logEvent('oauth.token', {
      outcome: 'ok',
      clientId: authCode.clientId,
      keyHashPrefix: keyHashPrefix(authCode.codeqr.accessToken),
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

interface AuthorizeRequest {
  client: RegisteredClient;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  clientState?: string;
  scope: string;
}

/**
 * Validation shared by showing the consent screen and acting on it, so the
 * form cannot be resubmitted with values the screen never displayed.
 *
 * Sends the error response itself and returns null when the request stops here.
 */
async function checkAuthorizeRequest(
  input: Record<string, unknown>,
  res: Response,
): Promise<AuthorizeRequest | null> {
  const clientId = param(input.client_id);
  const redirectUri = param(input.redirect_uri);
  const responseType = param(input.response_type);
  const codeChallenge = param(input.code_challenge);
  const codeChallengeMethod = param(input.code_challenge_method);
  const clientState = param(input.state);
  const scope = param(input.scope);

  if (!clientId || !redirectUri) {
    rejectAuthorize('missing_client_or_redirect');
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'client_id and redirect_uri are required',
    });
    return null;
  }

  // The redirect target is checked against what the client registered before
  // anything is echoed to it. Skipping this would let an attacker who knows a
  // client_id name their own redirect_uri and collect the authorization code.
  const client = await getRegisteredClient(clientId);

  if (!client) {
    rejectAuthorize('unknown_client');
    res.status(400).json({
      error: 'invalid_client',
      error_description: 'Unknown client_id. Register via POST /oauth/register first.',
    });
    return null;
  }

  if (!client.redirectUris.includes(redirectUri)) {
    rejectAuthorize('redirect_uri_mismatch', clientId);
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'redirect_uri does not match any URI registered for this client',
    });
    return null;
  }

  // Re-checked here for clients registered before /register validated URIs.
  if (!isAllowedRedirectUri(redirectUri)) {
    rejectAuthorize('redirect_uri_not_allowed', clientId);
    res.status(400).json({
      error: 'invalid_request',
      error_description: 'redirect_uri is not an allowed redirect target',
    });
    return null;
  }

  // From here the redirect_uri is trusted, so failures are reported to the
  // client as OAuth errors rather than as an HTTP page the user is stuck on.
  if (responseType !== 'code') {
    rejectAuthorize('unsupported_response_type', clientId);
    redirectWithError(res, redirectUri, 'unsupported_response_type', 'Only "code" is supported', clientState);
    return null;
  }

  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    rejectAuthorize('pkce_required', clientId);
    redirectWithError(
      res,
      redirectUri,
      'invalid_request',
      'PKCE with S256 code_challenge_method is required',
      clientState,
    );
    return null;
  }

  if (!hasCodeQROAuthCredentials()) {
    rejectAuthorize('server_not_configured', clientId);
    redirectWithError(
      res,
      redirectUri,
      'server_error',
      'This MCP server is not configured to authorize against CodeQR',
      clientState,
    );
    return null;
  }

  return {
    client,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    clientState,
    scope: scope || 'mcp:tools',
  };
}

function rejectAuthorize(reason: string, clientId?: string): void {
  logEvent('oauth.consent', { outcome: 'error', reason, clientId });
}

function param(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The caller's IP for rate limiting. Vercel overwrites both headers with the
 * real client address; behind a proxy that forwards a client-supplied
 * X-Forwarded-For instead, the limit can be sidestepped.
 */
function clientAddress(req: Request): string {
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp) return realIp;

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0]!.trim();

  return req.socket.remoteAddress ?? 'unknown';
}

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
  status: 302 | 303 = 302,
): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);

  res.redirect(status, url.toString());
}
