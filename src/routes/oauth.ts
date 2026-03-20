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

    // Render authorization page matching CodeQR design standards
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize CodeQR</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --codeqr-primary: #6366f1;
      --codeqr-primary-hover: #4f46e5;
      --codeqr-bg: #0f0f0f;
      --codeqr-surface: #1a1a1a;
      --codeqr-surface-elevated: #242424;
      --codeqr-border: #2a2a2a;
      --codeqr-text: #ffffff;
      --codeqr-text-secondary: #a0a0a0;
      --codeqr-text-tertiary: #6b6b6b;
      --codeqr-input-bg: #151515;
      --codeqr-input-border: #2a2a2a;
      --codeqr-input-focus: #6366f1;
      --codeqr-success: #10b981;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--codeqr-bg);
      color: var(--codeqr-text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .container {
      width: 100%;
      max-width: 480px;
    }
    .card {
      background: var(--codeqr-surface);
      border: 1px solid var(--codeqr-border);
      border-radius: 20px;
      padding: 48px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    .logo-container {
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 32px;
    }
    .logo {
      display: block;
      height: 40px;
      width: auto;
    }
    .logo img {
      height: 100%;
      width: auto;
      display: block;
    }
    .header {
      text-align: center;
      margin-bottom: 40px;
    }
    .title {
      font-size: 24px;
      font-weight: 600;
      color: var(--codeqr-text);
      margin-bottom: 12px;
      letter-spacing: -0.3px;
    }
    .subtitle {
      color: var(--codeqr-text-secondary);
      font-size: 15px;
      line-height: 1.6;
    }
    .form-group {
      margin-bottom: 24px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--codeqr-text-secondary);
      margin-bottom: 8px;
      letter-spacing: 0.1px;
    }
    .input-wrapper {
      position: relative;
    }
    input[type="text"] {
      width: 100%;
      padding: 14px 16px;
      background: var(--codeqr-input-bg);
      border: 1.5px solid var(--codeqr-input-border);
      border-radius: 12px;
      color: var(--codeqr-text);
      font-size: 14px;
      font-family: 'SF Mono', 'Monaco', 'Cascadia Code', 'Consolas', monospace;
      outline: none;
      transition: all 0.2s ease;
    }
    input[type="text"]:hover {
      border-color: var(--codeqr-border);
    }
    input[type="text"]:focus {
      border-color: var(--codeqr-input-focus);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    }
    input[type="text"]::placeholder {
      color: var(--codeqr-text-tertiary);
    }
    .info-box {
      margin-top: 16px;
      padding: 16px;
      background: var(--codeqr-surface-elevated);
      border: 1px solid var(--codeqr-border);
      border-radius: 12px;
      font-size: 13px;
      color: var(--codeqr-text-secondary);
      line-height: 1.6;
    }
    .info-box a {
      color: var(--codeqr-primary);
      text-decoration: none;
      font-weight: 500;
      transition: color 0.2s;
    }
    .info-box a:hover {
      color: var(--codeqr-primary-hover);
      text-decoration: underline;
    }
    .actions {
      margin-top: 32px;
      display: flex;
      gap: 12px;
    }
    button {
      flex: 1;
      padding: 14px 24px;
      border: none;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
    }
    .btn-authorize {
      background: var(--codeqr-primary);
      color: white;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
    }
    .btn-authorize:hover {
      background: var(--codeqr-primary-hover);
      box-shadow: 0 6px 16px rgba(99, 102, 241, 0.4);
      transform: translateY(-1px);
    }
    .btn-authorize:active {
      transform: translateY(0);
    }
    .btn-cancel {
      background: transparent;
      color: var(--codeqr-text-secondary);
      border: 1.5px solid var(--codeqr-border);
    }
    .btn-cancel:hover {
      background: var(--codeqr-surface-elevated);
      border-color: var(--codeqr-border);
      color: var(--codeqr-text);
    }
    .client-info {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid var(--codeqr-border);
      text-align: center;
    }
    .client-label {
      font-size: 12px;
      color: var(--codeqr-text-tertiary);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 500;
    }
    .client-id {
      font-size: 13px;
      color: var(--codeqr-text-secondary);
      font-family: 'SF Mono', 'Monaco', 'Cascadia Code', 'Consolas', monospace;
      word-break: break-all;
    }
    @media (max-width: 640px) {
      .card {
        padding: 32px 24px;
        border-radius: 16px;
      }
      .logo {
        height: 36px;
      }
      .title {
        font-size: 22px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo-container">
        <div class="logo">
          <img 
            src="https://res.cloudinary.com/dhnaggn4g/image/upload/v1773973005/codeqr.io/logo/logo_dark.png" 
            alt="CodeQR" 
            loading="eager"
          >
        </div>
      </div>
      <div class="header">
        <h1 class="title">Authorize Application</h1>
        <p class="subtitle">
          An application is requesting access to your CodeQR account via MCP.
          Enter your API key to continue.
        </p>
      </div>

      <form method="POST" action="${serverUrl}/oauth/authorize">
        <input type="hidden" name="client_id" value="${escapeHtml(client_id)}">
        <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
        <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge)}">
        <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method)}">
        <input type="hidden" name="state" value="${escapeHtml(state || '')}">
        <input type="hidden" name="scope" value="${escapeHtml(scope || 'mcp:tools')}">

        <div class="form-group">
          <label for="api_key">CodeQR API Key</label>
          <div class="input-wrapper">
            <input 
              type="text" 
              id="api_key" 
              name="api_key" 
              placeholder="codeqr_xxxx..." 
              required 
              autocomplete="off"
              spellcheck="false"
            >
          </div>
          <div class="info-box">
            Get your API key at
            <a href="https://app.codeqr.io/settings/tokens" target="_blank" rel="noopener noreferrer">
              app.codeqr.io/settings/tokens
            </a>.
            Your key is encrypted and only used to make API calls on your behalf.
          </div>
        </div>

        <div class="actions">
          <button type="button" class="btn-cancel" onclick="window.close()">Cancel</button>
          <button type="submit" class="btn-authorize">Authorize</button>
        </div>
      </form>

      <div class="client-info">
        <div class="client-label">Requesting Application</div>
        <div class="client-id">${escapeHtml(client_id)}</div>
      </div>
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
