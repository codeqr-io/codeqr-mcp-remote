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
import { getServerUrl } from '../config.js';

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
  const params = [`realm="codeqr-mcp"`, `error="${error}"`, `error_description="${description}"`];

  if (error !== 'invalid_request') {
    params.push(`resource_metadata="${getServerUrl(req)}/.well-known/oauth-protected-resource"`);
  }

  res.setHeader('WWW-Authenticate', `Bearer ${params.join(', ')}`);
  res.status(401).json({ error, error_description: description });
}

export async function requireBearerToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
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
    unauthorized(req, res, 'invalid_token', 'Access token is invalid or expired');
    return;
  }

  let codeqrToken: string;
  try {
    codeqrToken = await resolveCodeQRToken(accessToken);
  } catch {
    // The refresh token is spent, revoked, or past its 120 days. Nothing here
    // can recover it — the user has to authorize again, and invalid_token is
    // what tells the client to walk them through that.
    unauthorized(
      req,
      res,
      'invalid_token',
      'CodeQR authorization has expired. Please reconnect the app.',
    );
    return;
  }

  req.codeqrApiKey = codeqrToken;
  req.oauthClientId = accessToken.clientId;
  req.oauthScope = accessToken.scope;

  next();
}
