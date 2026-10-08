/**
 * OAuth Bearer token middleware.
 *
 * Validates the access token from the Authorization header, renews the CodeQR
 * credentials behind it when they are close to expiring, and attaches the token
 * the MCP handler should call the CodeQR API with.
 */

import type { Request, Response, NextFunction } from 'express';
import { validateAccessToken } from '../oauth/store.js';
import { resolveCodeQRToken } from '../oauth/refresh.js';
import { CodeQROAuthError } from '../oauth/codeqr-oauth.js';
import { getServerUrl } from '../config.js';
import { keyHashPrefix, logEvent } from '../telemetry.js';

declare global {
  namespace Express {
    interface Request {
      /**
       * The credential the CodeQR API is called with — an OAuth access token
       * for sessions created through the broker, or a personal API key for
       * ones that predate it. The API accepts both identically.
       */
      codeqrApiKey?: string;
      oauthClientId?: string;
      oauthScope?: string;
      /** First characters of the CodeQR token's hash; see telemetry.ts. */
      keyHashPrefix?: string;
    }
  }
}

/**
 * Answer a 401 that points the client at how to authenticate.
 *
 * The header has to be set before the body is sent — writing it afterwards is
 * a no-op, and MCP clients rely on `resource_metadata` here to discover the
 * authorization server and start the OAuth flow (RFC 9728).
 */
function unauthorized(req: Request, res: Response, error: string, description: string): void {
  // resource_metadata goes on every 401, including the one answering a request
  // with no token at all — that is the first call any MCP client makes and the
  // only place it can bootstrap discovery from.
  res.setHeader(
    'WWW-Authenticate',
    [
      `Bearer realm="codeqr-mcp"`,
      `error="${error}"`,
      `error_description="${description}"`,
      `resource_metadata="${getServerUrl(req)}/.well-known/oauth-protected-resource"`,
    ].join(', '),
  );
  res.status(401).json({ error, error_description: description });
}

export async function requireBearerToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reject(req, 401, authHeader ? 'malformed_authorization' : 'missing_authorization');
    unauthorized(
      req,
      res,
      'invalid_request',
      'Missing or invalid Authorization header. Expected: Bearer <token>',
    );
    return;
  }

  const token = authHeader.slice('Bearer '.length);
  const accessToken = await validateAccessToken(token);

  if (!accessToken) {
    reject(req, 401, 'unknown_or_expired_token');
    unauthorized(req, res, 'invalid_token', 'Access token is invalid or expired');
    return;
  }

  let codeqrToken: string;
  try {
    codeqrToken = await resolveCodeQRToken(accessToken);
  } catch (err) {
    // Only `invalid_grant` means the authorization is genuinely gone — spent,
    // revoked, or past its 120 days. Everything else (CodeQR 5xx, an Upstash
    // blip, the wait timing out) is temporary, and answering 401 for those
    // would send the user to re-authorize over a problem that fixes itself —
    // and each re-authorization costs them their other MCP session.
    if (err instanceof CodeQROAuthError && err.code === 'invalid_grant') {
      reject(req, 401, 'codeqr_grant_revoked', accessToken.clientId);
      unauthorized(
        req,
        res,
        'invalid_token',
        'CodeQR authorization is no longer valid. Please reconnect the app.',
      );
      return;
    }

    reject(req, 503, 'codeqr_refresh_unavailable', accessToken.clientId);
    res.status(503).json({
      error: 'temporarily_unavailable',
      error_description: 'Could not renew CodeQR authorization right now. Try again shortly.',
    });
    return;
  }

  req.codeqrApiKey = codeqrToken;
  req.oauthClientId = accessToken.clientId;
  req.oauthScope = accessToken.scope;
  req.keyHashPrefix = keyHashPrefix(codeqrToken);

  next();
}

/**
 * Most refusals here are unauthenticated discovery probes — registries and
 * scanners hit /mcp around the clock — so the user agent is what tells them
 * apart from a client whose session stopped working.
 */
function reject(req: Request, status: number, reason: string, clientId?: string): void {
  logEvent('mcp.rejected', {
    status,
    reason,
    clientId,
    userAgent: req.headers['user-agent'],
  });
}
