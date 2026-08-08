/**
 * MCP endpoint handler.
 *
 * Receives authenticated requests (Bearer token from OAuth flow),
 * resolves the user's CodeQR API key, and runs the MCP server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Codeqr from '@codeqr/ts';
import type { Request, Response } from 'express';

// ── Tool Definitions ─────────────────────────────────────────────────────────

/**
 * Annotations describe what a tool actually does, so the client can decide when
 * to ask the user for confirmation. They are required for directory submission,
 * and mislabelled ones are one of the most common rejection reasons.
 *
 *   readOnlyHint    — only reads; never changes stored state.
 *   openWorldHint   — changes something publicly reachable on the internet
 *                     (a live short link or QR destination), as opposed to
 *                     private bookkeeping inside the workspace.
 *   destructiveHint — deletes, overwrites, or causes an effect that cannot be
 *                     taken back.
 *
 * Why `update_link` and `update_qrcode` are destructive: both overwrite the
 * destination of a code that may already be printed on physical material or
 * handed out. The record is restorable, the printed sheet is not — so the
 * caller deserves a confirmation prompt. This mirrors the warning the CodeQR
 * dashboard already shows before an edit changes an encoded payload.
 */
const READ_ONLY = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
/** Creates something publicly reachable, but overwrites nothing. */
const PUBLISHES = { readOnlyHint: false, openWorldHint: true, destructiveHint: false };
/** Overwrites or removes something publicly reachable. */
const REWRITES_PUBLIC = { readOnlyHint: false, openWorldHint: true, destructiveHint: true };
/** Writes only to private workspace state — nothing changes on the open web. */
const PRIVATE_WRITE = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };

const TOOLS = [
  {
    name: 'create_link',
    annotations: PUBLISHES,
    description:
      'Create a trackable short link. The link is a live endpoint: it keeps resolving after this conversation ends, and its destination can be changed later with update_link.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The destination URL to shorten' },
        domain: { type: 'string', description: 'Custom domain (optional)' },
        key: { type: 'string', description: 'Custom slug/key (optional, auto-generated if omitted)' },
        externalId: { type: 'string', description: 'External reference ID (optional)' },
        tagIds: { type: 'array', items: { type: 'string' }, description: 'Tag IDs to associate (optional)' },
        comments: { type: 'string', description: 'Internal notes (optional)' },
        expiresAt: { type: 'string', description: 'Expiration date ISO 8601 (optional)' },
        password: { type: 'string', description: 'Password protect the link (optional)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_links',
    annotations: READ_ONLY,
    description: 'List all short links in your CodeQR workspace',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Search keyword (optional)' },
        domain: { type: 'string', description: 'Filter by domain (optional)' },
        tagId: { type: 'string', description: 'Filter by tag ID (optional)' },
        page: { type: 'number', description: 'Page number (optional)' },
      },
    },
  },
  {
    name: 'get_link_info',
    annotations: READ_ONLY,
    description: 'Get detailed information about a specific short link',
    inputSchema: {
      type: 'object' as const,
      properties: {
        linkId: { type: 'string', description: 'The link ID' },
        domain: { type: 'string', description: 'Domain (alternative to linkId)' },
        key: { type: 'string', description: 'Slug/key (use with domain)' },
        externalId: { type: 'string', description: 'External ID (alternative to linkId)' },
      },
    },
  },
  {
    name: 'update_link',
    annotations: REWRITES_PUBLIC,
    description:
      'Change where an existing short link points, without changing the link itself. Anything already shared keeps working and now leads to the new destination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        linkId: { type: 'string', description: 'The link ID to update' },
        url: { type: 'string', description: 'New destination URL (optional)' },
        key: { type: 'string', description: 'New slug (optional)' },
        archived: { type: 'boolean', description: 'Archive status (optional)' },
        expiresAt: { type: 'string', description: 'New expiration date (optional)' },
        comments: { type: 'string', description: 'Updated comments (optional)' },
      },
      required: ['linkId'],
    },
  },
  {
    name: 'delete_link',
    annotations: REWRITES_PUBLIC,
    description: 'Delete a short link. Anything already shared stops resolving.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        linkId: { type: 'string', description: 'The link ID to delete' },
      },
      required: ['linkId'],
    },
  },
  {
    name: 'create_qrcode',
    annotations: PUBLISHES,
    description:
      'Create a dynamic QR code. The code encodes a short link rather than the destination itself, so the destination can be changed later with update_qrcode without reprinting the code. Scans are recorded.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The destination the QR code should lead to' },
        domain: { type: 'string', description: 'Domain for the underlying short link (optional)' },
        key: { type: 'string', description: 'Custom slug for the underlying short link (optional, auto-generated if omitted)' },
        size: { type: 'number', description: 'Size in pixels (optional)' },
        level: { type: 'string', enum: ['L', 'M', 'Q', 'H'], description: 'Error correction level (optional)' },
        fgColor: { type: 'string', description: 'Foreground color hex (optional)' },
        bgColor: { type: 'string', description: 'Background color hex (optional)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_qrcodes',
    annotations: READ_ONLY,
    description: 'List all QR codes in your workspace',
    inputSchema: {
      type: 'object' as const,
      properties: {
        page: { type: 'number', description: 'Page number (optional)' },
      },
    },
  },
  {
    name: 'get_qrcode_info',
    annotations: READ_ONLY,
    description: 'Get detailed information about a specific QR code, including its current destination and scan count',
    inputSchema: {
      type: 'object' as const,
      properties: {
        qrcodeId: { type: 'string', description: 'The QR code ID' },
        domain: { type: 'string', description: 'Domain (alternative to qrcodeId, use with key)' },
        key: { type: 'string', description: 'Slug/key (use with domain)' },
      },
    },
  },
  {
    name: 'update_qrcode',
    annotations: REWRITES_PUBLIC,
    description:
      'Change where an existing QR code leads, without reprinting it. Codes already printed or distributed keep working and now lead to the new destination. This is the reason to use a dynamic QR code instead of a generated image.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        qrcodeId: { type: 'string', description: 'The QR code ID to update' },
        url: { type: 'string', description: 'New destination URL (optional)' },
        fgColor: { type: 'string', description: 'New foreground color hex (optional)' },
        bgColor: { type: 'string', description: 'New background color hex (optional)' },
        archived: { type: 'boolean', description: 'Archive status (optional)' },
      },
      required: ['qrcodeId'],
    },
  },
  {
    name: 'delete_qrcode',
    annotations: REWRITES_PUBLIC,
    description: 'Delete a QR code. Any printed copy stops resolving and cannot be recovered by reprinting.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        qrcodeId: { type: 'string', description: 'The QR code ID to delete' },
      },
      required: ['qrcodeId'],
    },
  },
  {
    name: 'get_analytics',
    annotations: READ_ONLY,
    description:
      'Get scan and click analytics — workspace-wide, or for one link or QR code. Group by time, country, city, device, or browser.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        event: {
          type: 'string',
          // 'scans' is what makes a QR code measurable at all; leaving it out
          // meant an agent could never answer "how many scans did this get".
          enum: ['clicks', 'scans', 'leads', 'sales', 'composite'],
          description: 'Event type to query. Use "scans" for QR codes and "clicks" for short links.',
        },
        groupBy: {
          // Deliberately narrower than the API accepts: 'clicks', 'scans' and
          // 'views' are also valid values upstream but currently answer 500,
          // so offering them here would only send the agent into a failure.
          type: 'string',
          enum: ['count', 'timeseries', 'countries', 'cities', 'devices', 'browsers', 'os', 'referers', 'top_links', 'top_qrcodes', 'top_urls'],
          description: 'How to group the results',
        },
        linkId: { type: 'string', description: 'Filter by link ID (optional)' },
        qrcodeId: { type: 'string', description: 'Filter by QR code ID (optional)' },
        domain: { type: 'string', description: 'Filter by domain (optional)' },
        key: { type: 'string', description: 'Filter by slug/key, use with domain (optional)' },
        interval: { type: 'string', description: 'Time interval: 24h, 7d, 30d, 90d (optional)' },
      },
      required: ['event', 'groupBy'],
    },
  },
  {
    name: 'list_domains',
    annotations: READ_ONLY,
    description: 'List custom domains configured in your workspace',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_tags',
    annotations: READ_ONLY,
    description: 'List all tags in your workspace',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_tag',
    // Organisational label inside the workspace — nothing on the open web changes.
    annotations: PRIVATE_WRITE,
    description: 'Create a new tag for organizing links',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Tag name' },
        color: { type: 'string', description: 'Tag color (optional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'track_lead',
    // Records a conversion event against our own analytics. Nothing is published.
    annotations: PRIVATE_WRITE,
    description: 'Track a lead conversion attributed to a short link',
    inputSchema: {
      type: 'object' as const,
      properties: {
        clickId: { type: 'string', description: 'The click ID from the link visit' },
        eventName: { type: 'string', description: 'Conversion event name' },
        customerId: { type: 'string', description: 'Your customer identifier' },
        customerName: { type: 'string', description: 'Customer name (optional)' },
        customerEmail: { type: 'string', description: 'Customer email (optional)' },
      },
      required: ['clickId', 'eventName', 'customerId'],
    },
  },
  {
    name: 'track_sale',
    annotations: PRIVATE_WRITE,
    description: 'Track a sale conversion attributed to a short link',
    inputSchema: {
      type: 'object' as const,
      properties: {
        clickId: { type: 'string', description: 'The click ID from the link visit' },
        eventName: { type: 'string', description: 'Sale event name' },
        customerId: { type: 'string', description: 'Your customer identifier' },
        amount: { type: 'number', description: 'Amount in cents (e.g., 4999 for $49.99)' },
        currency: { type: 'string', description: 'Currency code (e.g., usd)' },
        paymentProcessor: { type: 'string', description: 'Payment processor name' },
      },
      required: ['clickId', 'eventName', 'customerId', 'amount'],
    },
  },
];

// ── Tool Handler ─────────────────────────────────────────────────────────────

async function handleToolCall(
  client: Codeqr,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    let result: unknown;

    switch (name) {
      case 'create_link':
        result = await client.links.create(args as any);
        break;
      case 'list_links':
        result = await client.links.list(args as any);
        break;
      case 'get_link_info':
        result = await client.links.retrieveInfo(args as any);
        break;
      case 'update_link': {
        const { linkId, ...params } = args as any;
        result = await client.links.update(linkId, params);
        break;
      }
      case 'delete_link':
        result = await client.links.delete(args.linkId as string);
        break;
      case 'create_qrcode':
        result = await client.qrcodes.create(args as any);
        break;
      case 'list_qrcodes':
        result = await client.qrcodes.list(args as any);
        break;
      case 'get_qrcode_info':
        result = await client.qrcodes.retrieve(args as any);
        break;
      case 'update_qrcode': {
        const { qrcodeId, ...params } = args as any;
        result = await client.qrcodes.update(qrcodeId, params);
        break;
      }
      case 'delete_qrcode':
        result = await client.qrcodes.delete(args.qrcodeId as string);
        break;
      case 'get_analytics':
        result = await client.analytics.retrieve(args as any);
        break;
      case 'list_domains':
        result = await client.domains.list();
        break;
      case 'list_tags':
        result = await client.tags.list();
        break;
      case 'create_tag':
        result = await client.tags.create(args as any);
        break;
      case 'track_lead':
        result = await client.track.trackLead(args as any);
        break;
      case 'track_sale':
        result = await client.track.trackSale(args as any);
        break;
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}

// ── MCP Request Handler ──────────────────────────────────────────────────────

export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const apiKey = req.codeqrApiKey;

  if (!apiKey) {
    res.status(401).json({
      error: 'unauthorized',
      error_description: 'No API key associated with this token',
    });
    return;
  }

  // Create a new MCP server instance per request
  const server = new McpServer(
    { name: 'codeqr', version: '0.19.3' },
    {
      instructions: [
        'You are connected to CodeQR via MCP.',
        'CodeQR provides managed destinations, not images: every short link and QR code you create here is a live endpoint whose destination stays editable after the code has been printed or shared, and whose scans and clicks are recorded.',
        'Prefer these tools over generating a QR image locally whenever the code needs to outlive the conversation, be re-pointed later, or be measured.',
        'You can create and update short links and QR codes, read scan and click analytics, manage domains and tags, and track conversions.',
      ].join(' '),
      capabilities: { tools: {} },
    },
  );

  // Create CodeQR client with the user's API key
  const client = new Codeqr({ apiKey });

  // Register tool handlers on the underlying server
  const innerServer = server.server;

  innerServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  innerServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(client, name, args as Record<string, unknown>);
  });

  // Handle the request via StreamableHTTP transport
  const transport = new StreamableHTTPServerTransport();
  await server.connect(transport as any);
  await transport.handleRequest(req, res, req.body);
}
