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

const TOOLS = [
  {
    name: 'create_link',
    description: 'Create a shortened link with CodeQR',
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
    description: 'Update an existing short link',
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
    description: 'Delete a short link',
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
    description: 'Generate a QR code for a URL',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to encode in the QR code' },
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
    description: 'List all QR codes in your workspace',
    inputSchema: {
      type: 'object' as const,
      properties: {
        page: { type: 'number', description: 'Page number (optional)' },
      },
    },
  },
  {
    name: 'get_analytics',
    description: 'Get analytics data for your links (clicks, countries, devices, etc.)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        event: {
          type: 'string',
          enum: ['clicks', 'leads', 'sales'],
          description: 'Event type to query',
        },
        groupBy: {
          type: 'string',
          enum: ['count', 'timeseries', 'countries', 'cities', 'devices', 'browsers', 'os', 'referers', 'top_links', 'top_urls'],
          description: 'How to group the results',
        },
        linkId: { type: 'string', description: 'Filter by link ID (optional)' },
        domain: { type: 'string', description: 'Filter by domain (optional)' },
        interval: { type: 'string', description: 'Time interval: 24h, 7d, 30d, 90d (optional)' },
      },
      required: ['event', 'groupBy'],
    },
  },
  {
    name: 'list_domains',
    description: 'List custom domains configured in your workspace',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_tags',
    description: 'List all tags in your workspace',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_tag',
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
        'You are connected to the CodeQR API via MCP.',
        'You can create short links, generate QR codes, view analytics, manage domains and tags, and track conversions.',
        'Use the available tools to help the user manage their CodeQR resources.',
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
