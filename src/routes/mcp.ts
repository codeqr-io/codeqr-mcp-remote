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
import { getWorkspace } from '../codeqr/workspace.js';
import { SERVER_VERSION } from '../config.js';

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
 * The reading of `openWorldHint` above is the directory's, not the MCP spec's.
 * The spec frames it as whether the tool's domain of interaction is open or
 * closed, and defaults it to true — by which every tool here would be true,
 * since all of them call an external API, and the flag would carry no signal.
 * The directory asks instead whether the write becomes publicly visible, and
 * that is the axis encoded here, because that is what the reviewer checks.
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

export const TOOLS = [
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
  // `domain` and `key` are both required, and neither `linkId` nor `externalId`
  // is a substitute: the API requires the pair. The previous schema offered all
  // four as interchangeable optionals, so the natural call — `linkId` alone —
  // could only ever fail. `projectSlug` is required too, and is resolved from
  // the credential rather than asked for, because nothing an MCP client knows
  // could supply it.
  {
    name: 'get_link_info',
    annotations: READ_ONLY,
    description:
      'Get detailed information about one short link, identified by its domain and slug together (for codeqr.link/github: domain "codeqr.link", key "github"). To find a link when you only know part of it, use list_links with a search term first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'The link domain, e.g. "codeqr.link"' },
        key: { type: 'string', description: 'The link slug, e.g. "github"' },
      },
      required: ['domain', 'key'],
    },
  },
  {
    name: 'update_link',
    annotations: REWRITES_PUBLIC,
    description:
      'Change where an existing short link points. Anything already shared keeps working and now leads to the new destination — unless you also change `key`, which rewrites the link itself and breaks every copy already in circulation.',
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
        // Required by the API and by the SDK's own types, and it was missing:
        // every call this tool made was rejected before reaching creation. The
        // `as any` in the handler is what kept the compiler quiet about it.
        // Narrowed to 'url' on purpose. CodeQR supports text, email, wifi,
        // vcard, whatsapp, pix and more, but each of those carries its content
        // in a payload field of its own — `wifi: { ssid, encryption, ... }` —
        // and none of those fields is exposed here yet. Offering the types
        // without the payloads meant every non-url choice reached the API with
        // nothing to encode and came back a 400, so the enum advertised nine
        // capabilities the tool could not perform. Widen this only together
        // with the matching payload properties.
        type: {
          type: 'string',
          enum: ['url'],
          description: 'What kind of content the QR code encodes. Only "url" is supported here.',
        },
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
  // A `get_qrcode_info` tool was drafted here and pulled back out: the SDK's
  // retrieve() takes domain + key + projectSlug, not the id this server has,
  // so the tool would only ever have failed. `list_qrcodes` already returns
  // the id, destination and scan count, which is what it was there for.
  {
    name: 'update_qrcode',
    annotations: REWRITES_PUBLIC,
    description:
      'Change where a dynamic QR code leads, without reprinting it: the printed pattern encodes a short link, so copies already distributed now resolve to the new destination. This does NOT apply to static QR codes, which encode the destination directly in the printed pattern — for those, the stored record changes but anything already printed keeps leading to the old destination forever. Check whether the code is static before promising the change reaches printed material.',
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
        // Enumerated rather than free text: the API rejects anything outside
        // this set, and the old description named only four of the nine, so a
        // reasonable guess like "6m" or "last month" failed at the API instead
        // of at the schema.
        interval: {
          type: 'string',
          enum: ['1h', '24h', '7d', '30d', '90d', 'ytd', '1y', 'all', 'all_unfiltered'],
          description: 'Time window to report over (optional, defaults to 24h)',
        },
      },
      required: ['event', 'groupBy'],
    },
  },
  {
    name: 'list_domains',
    annotations: READ_ONLY,
    description: 'List custom domains configured in your workspace',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Search keyword (optional)' },
        page: { type: 'number', description: 'Page number (optional)' },
        pageSize: { type: 'number', description: 'Results per page (optional)' },
      },
    },
  },
  {
    name: 'list_tags',
    annotations: READ_ONLY,
    description: 'List all tags in your workspace',
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Search keyword (optional)' },
        page: { type: 'number', description: 'Page number (optional)' },
        pageSize: { type: 'number', description: 'Results per page (optional)' },
      },
    },
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
        // The API accepts these seven and rejects everything else. As free
        // text this silently produced 400s for any plausible colour name.
        color: {
          type: 'string',
          enum: ['red', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown'],
          description: 'Tag color (optional)',
        },
      },
      required: ['name'],
    },
  },
  // Answers "which workspace am I acting on, and what may it do" in one call.
  // Worth its own tool because plan gates several behaviours the agent would
  // otherwise discover by taking a 403 halfway through a batch.
  {
    name: 'get_workspace',
    annotations: READ_ONLY,
    description:
      'Get the CodeQR workspace this connection is authorized for, including its name, slug and plan. Useful before creating in bulk or using a feature the plan may not include.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  // track_lead and track_sale used to sit here. Two independent defects made
  // them unusable, and only one was fixable:
  //
  //   - they sent `customerId`, a field the API does not define; the required
  //     one is `customerExternalId`, so every call was rejected;
  //   - they need the `conversions.write` scope, which CodeQR grants to
  //     workspace owners only, and whose presence in an authorization request
  //     makes CodeQR reject that request outright for everyone else.
  //
  // The second is the blocking one: asking for the scope would stop members
  // connecting at all. Restoring the tools means giving conversions their own
  // consent step, not editing this list.
];

// ── Tool Handler ─────────────────────────────────────────────────────────────

/**
 * Narrow the untyped MCP arguments to the SDK's parameter type for a call.
 *
 * The client validates arguments against the tool's `inputSchema` before we see
 * them, so the shape is already checked at runtime; what this adds is a named
 * type at the call site instead of `any`. That matters because `any` is what
 * let `track_lead` ship for months sending `customerId`, a field the API never
 * had — the compiler had nothing to compare it against.
 *
 * The compiler still cannot tell whether a schema and the SDK have drifted
 * apart. `tests/tool-schemas.test.ts` is what covers that, and it is the thing
 * to update when the SDK changes.
 */
function asParams<T>(args: Record<string, unknown>): T {
  return args as T;
}

async function handleToolCall(
  client: Codeqr,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    let result: unknown;

    switch (name) {
      case 'create_link':
        result = await client.links.create(asParams<Codeqr.LinkCreateParams>(args));
        break;
      case 'list_links':
        result = await client.links.list(asParams<Codeqr.LinkListParams>(args));
        break;
      case 'get_link_info': {
        // `projectSlug` is required by the API and is not something any MCP
        // client could know, so it comes from the credential rather than the
        // caller. Without this the tool could not build a valid request at all.
        const { slug } = await getWorkspace(apiKey);
        result = await client.links.retrieveInfo({
          domain: args.domain as string,
          key: args.key as string,
          projectSlug: slug,
        });
        break;
      }
      case 'update_link': {
        const { linkId, ...params } = args;
        result = await client.links.update(
          linkId as string,
          asParams<Codeqr.LinkUpdateParams>(params),
        );
        break;
      }
      case 'delete_link':
        result = await client.links.delete(args.linkId as string);
        break;
      case 'create_qrcode':
        // `type` is required upstream with no default of its own. Filling it
        // here keeps the common "make a QR code for this URL" call working
        // instead of failing validation before anything is created.
        result = await client.qrcodes.create(
          asParams<Codeqr.QrcodeCreateParams>({ type: 'url', ...args }),
        );
        break;
      case 'list_qrcodes':
        result = await client.qrcodes.list(asParams<Codeqr.QrcodeListParams>(args));
        break;
      case 'update_qrcode': {
        const { qrcodeId, ...params } = args;
        result = await client.qrcodes.update(
          qrcodeId as string,
          asParams<Codeqr.QrcodeUpdateParams>(params),
        );
        break;
      }
      case 'delete_qrcode':
        result = await client.qrcodes.delete(args.qrcodeId as string);
        break;
      case 'get_analytics':
        result = await client.analytics.retrieve(asParams<Codeqr.AnalyticsRetrieveParams>(args));
        break;
      // Both of these used to be called with no arguments at all, so `page`
      // and `pageSize` never reached the API and a workspace with more items
      // than one page reported a truncated list as if it were complete.
      case 'list_domains':
        result = await client.domains.list(asParams<Codeqr.DomainListParams>(args));
        break;
      case 'list_tags':
        result = await client.tags.list(asParams<Codeqr.TagListParams>(args));
        break;
      case 'create_tag':
        result = await client.tags.create(asParams<Codeqr.TagCreateParams>(args));
        break;
      case 'get_workspace':
        result = await getWorkspace(apiKey);
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

  // Create a new MCP server instance per request.
  //
  // The version is this server's, from package.json. It used to carry the
  // `@codeqr/ts` version instead, which clients read as the server's own and
  // report in diagnostics.
  const server = new McpServer(
    { name: 'codeqr', version: SERVER_VERSION },
    {
      instructions: [
        'You are connected to CodeQR via MCP.',
        'CodeQR provides managed destinations, not images: every short link and QR code you create here is a live endpoint whose destination stays editable after the code has been printed or shared, and whose scans and clicks are recorded.',
        'Prefer these tools over generating a QR image locally whenever the code needs to outlive the conversation, be re-pointed later, or be measured.',
        'You can create and update short links and QR codes, read scan and click analytics, and manage domains and tags.',
        'Conversion tracking is not available through this connection.',
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
    return handleToolCall(client, apiKey, name, args as Record<string, unknown>);
  });

  // Handle the request via StreamableHTTP transport
  const transport = new StreamableHTTPServerTransport();
  await server.connect(transport as any);
  await transport.handleRequest(req, res, req.body);
}
