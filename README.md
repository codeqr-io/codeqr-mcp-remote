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
3. User authorizes by entering their CodeQR API key
4. Client exchanges authorization code for access token (PKCE)
5. Client sends MCP tool calls with Bearer token to `POST /mcp`

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

### Docker

```bash
docker build -t codeqr-mcp-remote .
docker run -p 3000:3000 -e SERVER_URL=https://mcp.codeqr.io codeqr-mcp-remote
```

### Railway / Render / Fly.io

Set environment variables:
- `SERVER_URL` — Your public server URL (e.g., `https://mcp.codeqr.io`)
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
| `create_qrcode` | Generate a QR code |
| `list_qrcodes` | List all QR codes |
| `get_analytics` | Query click analytics |
| `list_domains` | List custom domains |
| `list_tags` | List tags |
| `create_tag` | Create a tag |
| `track_lead` | Track a lead conversion |
| `track_sale` | Track a sale conversion |

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |
| GET | `/.well-known/oauth-protected-resource` | No | OAuth resource metadata (RFC 9728) |
| GET | `/.well-known/oauth-authorization-server` | No | OAuth server metadata (RFC 8414) |
| POST | `/oauth/register` | No | Dynamic client registration (RFC 7591) |
| GET | `/oauth/authorize` | No | Authorization page |
| POST | `/oauth/authorize` | No | Authorization form submission |
| POST | `/oauth/token` | No | Token exchange |
| POST | `/mcp` | Bearer | MCP Streamable HTTP endpoint |

## Architecture

```
src/
├── index.ts              # Express app & server startup
├── config.ts             # Environment configuration
├── oauth/
│   ├── store.ts          # In-memory OAuth state (codes, tokens, clients)
│   └── pkce.ts           # PKCE S256 verification
├── middleware/
│   └── auth.ts           # Bearer token validation middleware
└── routes/
    ├── well-known.ts     # OAuth discovery metadata endpoints
    ├── oauth.ts          # Authorization & token endpoints
    └── mcp.ts            # MCP tool definitions & handlers
```

## Production Considerations

The current implementation uses **in-memory storage** for OAuth tokens and authorization codes. For production:

- **Replace `oauth/store.ts`** with Redis, PostgreSQL, or DynamoDB
- **Add rate limiting** to the OAuth and MCP endpoints
- **Add HTTPS** (usually handled by your reverse proxy / platform)
- **Add monitoring** (the `/health` endpoint is ready for probes)
- **Consider token rotation** for long-lived sessions

## License

MIT — [CodeQR](https://codeqr.io)
