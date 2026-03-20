/**
 * OAuth 2.0 Authorization Code flow with PKCE.
 *
 * Flow:
 * 1. ChatGPT registers dynamically via POST /oauth/register
 * 2. ChatGPT redirects user to GET /oauth/authorize
 * 3. User enters their CodeQR API key and approves
 * 4. Server redirects back to ChatGPT with authorization code
 * 5. ChatGPT exchanges code for access token via POST /oauth/token
 * 6. ChatGPT uses access token in MCP requests
 */

import { Router, type Request, type Response } from 'express';
import {
  createAuthorizationCode,
  consumeAuthorizationCode,
  createAccessToken,
  registerClient,
} from '../oauth/store.js';
import { verifyCodeChallenge } from '../oauth/pkce.js';
import { getServerUrl } from '../config.js';

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

  router.get('/authorize', (req: Request, res: Response) => {
    const {
      client_id,
      redirect_uri,
      response_type,
      code_challenge,
      code_challenge_method,
      state,
      scope,
    } = req.query as Record<string, string>;

    // Validate required parameters
    if (response_type !== 'code') {
      res.status(400).json({
        error: 'unsupported_response_type',
        error_description: 'Only "code" response_type is supported',
      });
      return;
    }

    if (!code_challenge || code_challenge_method !== 'S256') {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'PKCE with S256 code_challenge_method is required',
      });
      return;
    }

    if (!client_id || !redirect_uri) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'client_id and redirect_uri are required',
      });
      return;
    }

    const serverUrl = getServerUrl(req);

    // Render a simple authorization page where the user enters their API key
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize CodeQR</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #fafafa;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 16px;
      padding: 40px;
      max-width: 440px;
      width: 100%;
    }
    .logo {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 8px;
      color: #fff;
    }
    .logo span { color: #6366f1; }
    .subtitle {
      color: #888;
      margin-bottom: 32px;
      font-size: 14px;
      line-height: 1.5;
    }
    label {
      display: block;
      font-size: 13px;
      color: #aaa;
      margin-bottom: 8px;
      font-weight: 500;
    }
    input[type="text"] {
      width: 100%;
      padding: 12px 16px;
      background: #111;
      border: 1px solid #333;
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus { border-color: #6366f1; }
    input[type="text"]::placeholder { color: #555; }
    .info {
      margin-top: 12px;
      padding: 12px;
      background: #111;
      border-radius: 8px;
      font-size: 12px;
      color: #888;
      line-height: 1.5;
    }
    .info a { color: #6366f1; text-decoration: none; }
    .info a:hover { text-decoration: underline; }
    .actions { margin-top: 24px; display: flex; gap: 12px; }
    button {
      flex: 1;
      padding: 12px 20px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.9; }
    .btn-authorize {
      background: #6366f1;
      color: #fff;
    }
    .btn-cancel {
      background: #333;
      color: #ccc;
    }
    .client-info {
      font-size: 12px;
      color: #666;
      margin-top: 24px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Code<span>QR</span></div>
    <p class="subtitle">
      An application is requesting access to your CodeQR account via MCP.
      Enter your API key to authorize.
    </p>

    <form method="POST" action="${serverUrl}/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(client_id)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method)}">
      <input type="hidden" name="state" value="${escapeHtml(state || '')}">
      <input type="hidden" name="scope" value="${escapeHtml(scope || 'mcp:tools')}">

      <label for="api_key">CodeQR API Key</label>
      <input type="text" id="api_key" name="api_key" placeholder="cqr_live_..." required autocomplete="off">

      <div class="info">
        Get your API key at
        <a href="https://app.codeqr.io/settings/tokens" target="_blank">app.codeqr.io/settings/tokens</a>.
        Your key is encrypted and only used to make API calls on your behalf.
      </div>

      <div class="actions">
        <button type="button" class="btn-cancel" onclick="window.close()">Cancel</button>
        <button type="submit" class="btn-authorize">Authorize</button>
      </div>
    </form>

    <div class="client-info">
      Requesting app: ${escapeHtml(client_id)}
    </div>
  </div>
</body>
</html>`;

    res.type('html').send(html);
  });

  // ── Authorization POST (form submission) ───────────────────────────────────

  router.post('/authorize', async (req: Request, res: Response) => {
    const {
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
      scope,
      api_key,
    } = req.body;

    if (!api_key) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'API key is required',
      });
      return;
    }

    // Create authorization code bound to the user's API key
    const code = await createAuthorizationCode({
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      codeqrApiKey: api_key,
      scope: scope || 'mcp:tools',
    });

    // Redirect back to the client with the authorization code
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

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

    // Issue access token linked to the user's CodeQR API key
    const { token, expiresIn } = await createAccessToken({
      clientId: authCode.clientId,
      codeqrApiKey: authCode.codeqrApiKey,
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
