/**
 * OAuth Bearer token middleware.
 *
 * Validates the access token from the Authorization header and
 * attaches the user's CodeQR API key to the request for the MCP handler.
 */

import type { Request, Response, NextFunction } from 'express';
import { validateAccessToken } from '../oauth/store.js';

declare global {
  namespace Express {
    interface Request {
      codeqrApiKey?: string;
      oauthClientId?: string;
      oauthScope?: string;
    }
  }
}

export function requireBearerToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'unauthorized',
      error_description: 'Missing or invalid Authorization header. Expected: Bearer <token>',
    });
    res.setHeader('WWW-Authenticate', 'Bearer realm="codeqr-mcp"');
    return;
  }

  const token = authHeader.slice('Bearer '.length);
  const accessToken = validateAccessToken(token);

  if (!accessToken) {
    res.status(401).json({
      error: 'invalid_token',
      error_description: 'Access token is invalid or expired',
    });
    res.setHeader('WWW-Authenticate', 'Bearer realm="codeqr-mcp", error="invalid_token"');
    return;
  }

  // Attach the user's CodeQR API key to the request
  req.codeqrApiKey = accessToken.codeqrApiKey;
  req.oauthClientId = accessToken.clientId;
  req.oauthScope = accessToken.scope;

  next();
}
