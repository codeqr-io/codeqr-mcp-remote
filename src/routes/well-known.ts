/**
 * OAuth 2.0 Well-Known metadata endpoints required by ChatGPT.
 *
 * ChatGPT needs these endpoints to discover the authorization server
 * and understand how to authenticate with the MCP server.
 */

import { Router, type Request, type Response } from 'express';
import { getServerUrl } from '../config.js';

export const MCP_PATH = '/mcp';
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/**
 * The MCP endpoint is served at both `/` and `/mcp`, and each is its own
 * protected resource: Claude requires `resource` to equal the URL the user
 * entered, path included, so the `/mcp` document lives at the RFC 9728
 * path-suffixed location and the root one stays where it was.
 */
function resourcePath(req: Request): string {
  return req.path === MCP_PATH ? MCP_PATH : '';
}

/** Where the 401 sends a client to discover how to authenticate for this request's URL. */
export function resourceMetadataUrl(req: Request): string {
  return `${getServerUrl(req)}${PROTECTED_RESOURCE_PATH}${resourcePath(req)}`;
}

export function createWellKnownRouter(): Router {
  const router = Router();

  /**
   * OAuth Protected Resource Metadata (RFC 9728)
   *
   * Clients fetch this first to discover which authorization server
   * protects this resource.
   */
  const protectedResource = (path: string) => (req: Request, res: Response) => {
    const serverUrl = getServerUrl(req);

    res.json({
      resource: `${serverUrl}${path}`,
      authorization_servers: [serverUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:tools'],
    });
  };

  router.get('/oauth-protected-resource', protectedResource(''));
  router.get(`/oauth-protected-resource${MCP_PATH}`, protectedResource(MCP_PATH));

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
