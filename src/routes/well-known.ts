/**
 * OAuth 2.0 Well-Known metadata endpoints required by ChatGPT.
 *
 * ChatGPT needs these endpoints to discover the authorization server
 * and understand how to authenticate with the MCP server.
 */

import { Router, type Request, type Response } from 'express';
import { getServerUrl } from '../config.js';

export function createWellKnownRouter(): Router {
  const router = Router();

  /**
   * OAuth Protected Resource Metadata (RFC 9728)
   *
   * ChatGPT fetches this first to discover which authorization server
   * protects this resource.
   */
  router.get('/oauth-protected-resource', (req: Request, res: Response) => {
    const serverUrl = getServerUrl(req);

    res.json({
      resource: serverUrl,
      authorization_servers: [serverUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:tools'],
    });
  });

  /**
   * OAuth Authorization Server Metadata (RFC 8414)
   *
   * ChatGPT uses this to find the authorization and token endpoints.
   */
  router.get('/oauth-authorization-server', (req: Request, res: Response) => {
    const serverUrl = getServerUrl(req);

    res.json({
      issuer: serverUrl,
      authorization_endpoint: `${serverUrl}/oauth/authorize`,
      token_endpoint: `${serverUrl}/oauth/token`,
      registration_endpoint: `${serverUrl}/oauth/register`,
      scopes_supported: ['mcp:tools'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      service_documentation: 'https://docs.codeqr.io',
    });
  });

  return router;
}
