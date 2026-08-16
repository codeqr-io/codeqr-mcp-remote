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
| `update_qrcode` | Change where an existing QR code points, without reprinting it |
| `delete_qrcode` | Delete a QR code; printed copies stop resolving |
| `get_analytics` | Query click analytics |
| `list_domains` | List custom domains |
| `list_tags` | List tags |
| `create_tag` | Create a tag |
| `get_workspace` | Read the authorized workspace: name, slug and plan |

Conversion event tools are not offered. `track_lead` and `track_sale` need the
`conversions.write` scope, which CodeQR grants to workspace owners only, and
requesting it makes CodeQR reject the whole authorization for everyone else.
The per-link `trackConversion` toggle is a `links.write` field and IS exposed
on `create_link`/`update_link` (plans that include conversion tracking only).

Smart rules are exposed on `create_link`/`update_link` as `rules`: conditional
routing by any of the twelve attributes the API implements, and traffic
splitting across 2-4 destinations, which is how an A/B test is expressed — one
rule with no condition and a `split`. Business plan and above; below it the API
rejects the whole call. Four of the field's invariants cannot be stated in JSON
Schema (weights totalling 100, `url` xor `split`, the all-or-nothing condition,
the unconditional rule coming last), so they are checked in
`src/smart-rules.ts` before the request is sent — which saves a round-trip and
answers in a sentence, rather than the serialized error body the SDK surfaces.

The trap worth knowing: `value` is compared whole and case-insensitively
against what the request carries, which for three attributes is narrower than
the name suggests. `device` is the operating system (`iOS`, `Android`,
`Windows`, `Mac OS`, `Linux` — never `mobile`), `language` a two-letter code,
`referrer` a bare domain. A wrong value is not an error anywhere: the API
accepts any string and the rule silently never matches.

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

## Publishing to the MCP Registry

This server is listed in the official registry as `io.codeqr/codeqr`. The registry
stores only the metadata in `server.json` — never the code.

Publishing is authorized by DNS: a TXT record on the **apex** of `codeqr.io` holds
the public half of an Ed25519 key pair. Apex, not a selector — MCP DNS auth follows
SPF-style placement, and a record under `_mcp-auth.` fails with a generic signature
error that does not name the cause.

```bash
# 1. Bump the version in package.json, src/config.ts and server.json together.
#    `yarn test` fails if they drift — the registry refuses to republish a
#    version it already has.
#
#    Then bump it in the CodeQR app too: the Server Card at
#    app/.well-known/mcp/server-card.json/route.ts advertises this server's
#    version, and no test can reach across repos to check. It already drifted
#    once, to a release that never existed.

# 2. Authenticate with the private key (kept outside this repo).
PRIVATE_KEY="$(openssl pkey -in /path/to/codeqr-io.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --domain codeqr.io --private-key "$PRIVATE_KEY"

# 3. Publish, then confirm the entry is live.
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0/servers?search=codeqr"
```

If the key is ever rotated, **remove the old TXT record** — a stale one is tried
first and makes verification fail.

### Directory listings

Aggregators crawl the ecosystem and list servers whether or not anyone claims them,
so an unclaimed entry still exists — as a bot's guess at what this server does.
Claiming replaces the guess and unlocks editing the name and description a reader
sees. None of this is done by merging a file; each one is a one-time action on the
aggregator's own site.

| Directory | How ownership is claimed | Status |
|-----------|--------------------------|--------|
| [Official MCP Registry](https://registry.modelcontextprotocol.io) | `mcp-publisher` + DNS, as above | listed |
| [Glama](https://glama.ai) | `glama.json` in this repo, then run the claim flow once from an account listed in `maintainers` | file in repo; claim pending |
| [Smithery](https://smithery.ai) | `smithery mcp publish https://mcp.codeqr.io/mcp -n <org>/<name>` | pending |
| [PulseMCP](https://pulsemcp.com) | hand-reviewed submission on their site | pending |
| [mcp.so](https://mcp.so) | submission form / GitHub issue | pending |

The GitHub OAuth route Glama also offers only associates repos under a **personal**
account, which this repo is not — it belongs to the `codeqr-io` org. Hence the file.

## License

MIT — [CodeQR](https://codeqr.io)
