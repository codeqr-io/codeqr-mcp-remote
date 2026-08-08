# CodeQR Remote MCP Server

Remote MCP server for [CodeQR](https://codeqr.io) with OAuth 2.0 authentication. Compatible with ChatGPT, OpenAI Agents SDK, Grok (xAI), and any MCP client supporting Streamable HTTP transport.

## How It Works

```
┌──────────┐      ┌─────────────────────┐      ┌──────────┐
│  ChatGPT │      │  CodeQR MCP Remote  │      │ CodeQR   │
│  or any  │─────▶│                     │─────▶│ API      │
│  MCP     │◀─────│  OAuth 2.0 + MCP    │◀─────│          │
│  client  │      │  Streamable HTTP    │      │          │
└──────────┘      └─────────────────────┘      └──────────┘
```

1. Client discovers auth endpoints via `/.well-known/oauth-protected-resource`
2. Client registers dynamically via `POST /oauth/register`
3. `GET /oauth/authorize` sends the user to CodeQR, where they log in, choose
   which project to grant access to, and approve — no API key is ever handled
4. CodeQR returns them to `GET /oauth/callback`, which trades the code for an
   access + refresh token pair
5. Client exchanges authorization code for access token (PKCE)
6. Client sends MCP tool calls with Bearer token to `POST /mcp`

The CodeQR access token lasts 7 days and is renewed transparently, so the
session stays valid for the 120-day life of the refresh token.

## Quick Start

```bash
# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your SERVER_URL

# Development
npm run dev

# Production
npm run build
npm start
```

## Deploy

### Vercel (Recommended)

The project is configured for Vercel serverless functions:

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Set environment variables in Vercel dashboard:
# - SERVER_URL — Your public server URL (e.g., https://mcp.codeqr.io)
# - UPSTASH_REDIS_REST_URL — From your Upstash Redis database (REST API)
# - UPSTASH_REDIS_REST_TOKEN — From your Upstash Redis database
# - CODEQR_OAUTH_CLIENT_ID — client_id of the OAuth app registered in CodeQR
# - CODEQR_OAUTH_CLIENT_SECRET — its client_secret
# - CODEQR_APP_URL — Dashboard origin (default: https://app.codeqr.io)
# - STAINLESS_API_KEY — Optional Stainless API key
# - LOG_LEVEL — Log level (default: info)
```

The app will be available at `https://your-project.vercel.app`. All routes are handled by the serverless function at `api/server.ts`.

**OAuth storage:** Set **Upstash Redis** (`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`) so authorization codes, access tokens, and registered clients persist across serverless invocations. If these variables are omitted, the server falls back to an in-memory store (fine for local development only).

### Docker

```bash
docker build -t codeqr-mcp-remote .
docker run -p 3000:3000 -e SERVER_URL=https://mcp.codeqr.io codeqr-mcp-remote
```

### Railway / Render / Fly.io

Set environment variables:
- `SERVER_URL` — Your public server URL (e.g., `https://mcp.codeqr.io`)
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — Recommended for multi-instance or restarts
- `PORT` — Port (usually set automatically by the platform)

## Connect to ChatGPT

1. Deploy this server to a public URL
2. In ChatGPT, go to **Settings > Advanced > Developer Mode**
3. Go to the **Connectors** tab
4. Click **Add Connector**
5. Enter your server URL (e.g., `https://mcp.codeqr.io/mcp`)
6. ChatGPT will auto-discover the OAuth endpoints and prompt you to authorize

## Connect to OpenAI Agents SDK

```python
from openai import OpenAI

client = OpenAI()

response = client.responses.create(
    model="gpt-4o",
    tools=[{
        "type": "mcp",
        "server_label": "codeqr",
        "server_url": "https://mcp.codeqr.io/mcp",
        "require_approval": "never",
    }],
    input="Create a short link for https://example.com",
)
```

## Available Tools

| Tool | Description |
|------|-------------|
| `create_link` | Create a shortened link |
| `list_links` | List all short links |
| `get_link_info` | Get link details |
| `update_link` | Update a link |
| `delete_link` | Delete a link |
| `create_qrcode` | Create a dynamic QR code encoding a URL, Wi-Fi credentials, a contact card, WhatsApp, email, SMS, a phone number, text or a crypto request |
| `list_qrcodes` | List all QR codes |
| `get_analytics` | Query click analytics |
| `list_domains` | List custom domains |
| `list_tags` | List tags |
| `create_tag` | Create a tag |
| `get_workspace` | Read the authorized workspace: name, slug and plan |

Conversion tracking is not offered. `track_lead` and `track_sale` need the
`conversions.write` scope, which CodeQR grants to workspace owners only, and
requesting it makes CodeQR reject the whole authorization for everyone else.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |
| GET | `/.well-known/oauth-protected-resource` | No | OAuth resource metadata (RFC 9728) |
| GET | `/.well-known/oauth-authorization-server` | No | OAuth server metadata (RFC 8414) |
| POST | `/oauth/register` | No | Dynamic client registration (RFC 7591) |
| GET | `/oauth/authorize` | No | Redirects the user to CodeQR to approve |
| GET | `/oauth/callback` | No | Return leg from CodeQR |
| POST | `/oauth/token` | No | Token exchange |
| POST | `/mcp` | Bearer | MCP Streamable HTTP endpoint |

## Architecture

```
src/
├── index.ts              # Express app & server startup
├── config.ts             # Environment configuration
├── oauth/
│   ├── store.ts          # OAuth state: Upstash Redis or in-memory fallback
│   └── pkce.ts           # PKCE S256 verification
├── middleware/
│   └── auth.ts           # Bearer token validation middleware
└── routes/
    ├── well-known.ts     # OAuth discovery metadata endpoints
    ├── oauth.ts          # Authorization & token endpoints
    └── mcp.ts            # MCP tool definitions & handlers
```

## Production Considerations

- **OAuth persistence:** Configure **Upstash Redis** (see `.env.example`) for serverless and multi-instance deployments. Without it, the in-memory store is used (single process only).
- **Add rate limiting** to the OAuth and MCP endpoints
- **Add HTTPS** (usually handled by your reverse proxy / platform)
- **Add monitoring** (the `/health` endpoint is ready for probes)
- **Consider token rotation** for long-lived sessions

## License

MIT — [CodeQR](https://codeqr.io)
