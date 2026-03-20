/**
 * CodeQR Remote MCP Server
 *
 * A remote MCP server with OAuth 2.0 authentication compatible with:
 *   - ChatGPT (Developer Mode / Connectors)
 *   - OpenAI Agents SDK (Responses API)
 *   - Grok (xAI Remote MCP Tools)
 *   - Any MCP client supporting Streamable HTTP transport
 *
 * Flow:
 *   1. Client discovers auth via GET /.well-known/oauth-protected-resource
 *   2. Client registers via POST /oauth/register (Dynamic Client Registration)
 *   3. User authorizes via GET /oauth/authorize (enters CodeQR API key)
 *   4. Client exchanges code for token via POST /oauth/token (PKCE)
 *   5. Client sends MCP requests to POST /mcp with Bearer token
 */

import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { createWellKnownRouter } from './routes/well-known.js';
import { createOAuthRouter } from './routes/oauth.js';
import { handleMcpRequest } from './routes/mcp.js';
import { requireBearerToken } from './middleware/auth.js';

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'codeqr-mcp-remote', version: '0.1.0' });
});

// ── Well-Known endpoints (no auth) ──────────────────────────────────────────

app.use('/.well-known', createWellKnownRouter());

// ── OAuth endpoints (no auth) ───────────────────────────────────────────────

app.use('/oauth', createOAuthRouter());

// ── MCP endpoint (requires Bearer token) ────────────────────────────────────

app.post('/mcp', requireBearerToken, handleMcpRequest);

// Also support root path for simpler configuration
app.post('/', requireBearerToken, handleMcpRequest);

// ── 404 handler ──────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({
    error: 'not_found',
    error_description: 'Endpoint not found. MCP requests should be sent to POST /mcp',
    docs: 'https://docs.codeqr.io/mcp',
  });
});

// ── Start server ─────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                  CodeQR Remote MCP Server                    ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  🚀 Server running on port ${String(config.port).padEnd(33)}║
║                                                              ║
║  Endpoints:                                                  ║
║    Health:    GET  /health                                    ║
║    Metadata:  GET  /.well-known/oauth-protected-resource     ║
║    Auth:      GET  /.well-known/oauth-authorization-server   ║
║    Register:  POST /oauth/register                           ║
║    Authorize: GET  /oauth/authorize                          ║
║    Token:     POST /oauth/token                              ║
║    MCP:       POST /mcp                                      ║
║                                                              ║
║  ChatGPT setup:                                              ║
║    Add as connector in Developer Mode > Connectors           ║
║    Server URL: ${(config.serverUrl || `http://localhost:${config.port}`).padEnd(43)}║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});

export default app;
