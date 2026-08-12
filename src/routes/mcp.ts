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

/**
 * What a QR code can encode, and the payload each kind needs.
 *
 * CodeQR stores these payloads as free-form JSON, and the SDK types them as
 * `Record<string, string>` — so nothing upstream tells a model which keys to
 * fill. Get a key wrong and the record saves, the code renders, and it encodes
 * an empty or malformed value. There is no error to notice.
 *
 * The field names below are therefore not guesses: each one is what the display
 * page a dynamic scan lands on actually reads. That page, not
 * `qrCodeConstructor`, is the reference — the constructor encodes content into
 * the printed pattern, which is the static path, and this tool only creates
 * dynamic codes. Where the two disagree, the page wins: it reads
 * `crypto.address` while the constructor reads `crypto.email`, and it renders a
 * second work number from `vcard.telephone` that the constructor has no branch
 * for. Only the first of those can produce a wrong result, since `telephone` is
 * an extra field rather than a rival name for the same one — it is simply not
 * offered here yet.
 *
 * Three names would not be guessed by anyone, and are called out where they
 * appear — `email.cco`, `sms.subject` and `crypto.address`.
 *
 * Three of CodeQR's types are deliberately absent, and this is the reason:
 *
 *   pix       — the payload builds correctly, but a dynamic Pix code is not in
 *               the middleware's display-page list, so scanning one redirects
 *               to the site root instead of paying anything.
 *   geo       — the constructor reads `geo.latLog`, while `geo` holds the
 *               country-targeting map and the coordinates live in `latlog`.
 *               Every geo code encodes `geo:undefined`.
 *   facetime  — the constructor has no branch for it at all, so it falls
 *               through and encodes an empty string.
 *
 * All three need a fix in the CodeQR app, not here. Offering them would repeat
 * the mistake this file just corrected: advertising a capability that answers
 * with silence.
 */
const QRCODE_CONTENT_TYPES = [
  'url',
  'text',
  'email',
  'phone',
  'sms',
  'wifi',
  'vcard',
  'crypto',
  'whatsapp',
] as const;

const QRCODE_PAYLOAD_PROPERTIES = {
  url: { type: 'string', description: 'For type "url": the destination the code should lead to' },
  text: { type: 'string', description: 'For type "text": the plain text to encode' },
  phone: { type: 'string', description: 'For type "phone": the number to call, e.g. "+5511999999999"' },
  email: {
    type: 'object' as const,
    description: 'For type "email": the message a scan should open',
    properties: {
      email: { type: 'string', description: 'Recipient address' },
      subject: { type: 'string', description: 'Subject line' },
      body: { type: 'string', description: 'Message body' },
      cc: { type: 'string', description: 'CC address' },
      // Not a typo to be fixed: the stored field is `cco`, from the Portuguese
      // "com cópia oculta". Sending `bcc` writes a key nothing reads.
      cco: { type: 'string', description: 'BCC address. The field is named cco, not bcc' },
    },
    required: ['email'],
  },
  sms: {
    type: 'object' as const,
    description: 'For type "sms": the message a scan should compose',
    properties: {
      tel: { type: 'string', description: 'Recipient number' },
      // Named `subject`, used as the body — SMS has no subject line.
      subject: { type: 'string', description: 'The message text. Despite the name, this is the body, not a subject' },
    },
    required: ['tel'],
  },
  wifi: {
    type: 'object' as const,
    description: 'For type "wifi": the network a scan should join',
    properties: {
      ssid: { type: 'string', description: 'Network name' },
      password: { type: 'string', description: 'Network password' },
      // The dashboard writes "nome" for an open network, which is neither a
      // valid WIFI-spec value nor understood by scanners. Offering the correct
      // ones here rather than matching that.
      encryption: {
        type: 'string',
        enum: ['WPA', 'WPA2', 'WEP', 'nopass'],
        description: 'Security type. Use "nopass" for an open network',
      },
      // `isHidden` is not offered, and cannot be until the app changes. The
      // payload is validated as `z.record(z.string())`, so a boolean is
      // rejected outright — and the string that would pass is worse, because
      // the encoder tests it for truthiness, making "false" encode H:true.
      // The display page types it as a boolean it can never receive.
    },
    required: ['ssid'],
  },
  vcard: {
    type: 'object' as const,
    // city, state, zipcode and country are only written when `address` is
    // present — they are assembled into one ADR line. Sending a city on its own
    // silently drops it.
    description:
      'For type "vcard": the contact card a scan should offer to save. City, state, zipcode and country are only encoded when address is also given',
    properties: {
      name: { type: 'string', description: 'First name' },
      surname: { type: 'string', description: 'Last name' },
      phone: { type: 'string', description: 'Phone number' },
      email: { type: 'string', description: 'Email address' },
      website: { type: 'string', description: 'Website URL' },
      address: { type: 'string', description: 'Street address' },
      city: { type: 'string', description: 'City (requires address)' },
      state: { type: 'string', description: 'State or region (requires address)' },
      zipcode: { type: 'string', description: 'Postal code (requires address)' },
      country: { type: 'string', description: 'Country (requires address)' },
    },
  },
  crypto: {
    type: 'object' as const,
    description: 'For type "crypto": the payment request a scan should open',
    properties: {
      cryptocurrency: { type: 'string', description: 'Currency scheme, e.g. "bitcoin" or "ethereum"' },
      // CodeQR reads the wallet address from two different fields depending on
      // how the code is scanned: the display page every dynamic code lands on
      // reads `crypto.address`, while `qrCodeConstructor` — the static path —
      // reads `crypto.email`. This tool only creates dynamic codes, so
      // `address` is the one that has to be filled; sending `email` produces a
      // page reading "No crypto payment information available".
      address: { type: 'string', description: 'The destination wallet address' },
      amount: { type: 'string', description: 'Amount to request' },
      message: { type: 'string', description: 'Note attached to the request' },
    },
  },
  whatsapp: {
    type: 'object' as const,
    description: 'For type "whatsapp": the conversation a scan should open',
    properties: {
      number: {
        type: 'string',
        description: 'Number in E.164 without "+" or separators, e.g. "5511999999999". The API rejects anything else',
      },
      message: { type: 'string', description: 'Message pre-filled in the chat (optional, max 1000 characters)' },
    },
    required: ['number'],
  },
} as const;

// Exported so tests can hold this capability claim against what the tool
// schemas actually declare — this string has shipped an overclaim in both
// directions before.
export const SERVER_INSTRUCTIONS = [
  'You are connected to CodeQR via MCP.',
  'CodeQR provides managed destinations, not images: every short link and QR code you create here is a live endpoint whose destination stays editable after the code has been printed or shared, and whose scans and clicks are recorded.',
  'Prefer these tools over generating a QR image locally whenever the code needs to outlive the conversation, be re-pointed later, or be measured.',
  'You can create and update short links and QR codes, read scan and click analytics, and manage domains and tags.',
  'On plans that include it, per-link conversion tracking can be toggled with trackConversion on create_link/update_link, and links can carry a custom social preview (proxy + title/description/image).',
  'Recording or querying conversion events (leads, sales) is not available through this connection; link objects do report clicks, leads and sales counters.',
].join(' ');

export const TOOLS = [
  {
    name: 'create_link',
    title: 'Create Short Link',
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
        trackConversion: { type: 'boolean', description: 'Enable conversion tracking for this link (optional; only on plans that include conversion tracking — on other plans the API rejects the entire call. Appends a cq_id attribution parameter to the destination URL)' },
        proxy: { type: 'boolean', description: 'Show a custom social media preview instead of the destination page metadata (optional; set title, description and image in the same call — proxy without them renders an empty preview card)' },
        title: { type: 'string', description: 'Custom preview title (optional; used with proxy, truncated at 120 chars)' },
        description: { type: 'string', description: 'Custom preview description (optional; used with proxy, truncated at 240 chars)' },
        image: { type: 'string', description: 'Custom preview image URL (optional; used with proxy)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_links',
    title: 'List Short Links',
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
  // Any one of these identifies a link: `linkId`, `externalId`, or `domain`
  // and `key` together. The API rejects the call only when all four are
  // missing, and it resolves the workspace from the credential rather than
  // from a `projectSlug` argument.
  //
  // That last point is worth stating because the SDK's type disagrees: it
  // marks `domain`, `key` and `projectSlug` as required. The type is generated
  // from the OpenAPI document, which is stricter here than the route it
  // describes, and the SDK forwards the query untouched. Trusting the type
  // over the route would drop `linkId` — the identifier `list_links` actually
  // returns, and so the one an agent has in hand.
  {
    name: 'get_link_info',
    title: 'Get Link Details',
    annotations: READ_ONLY,
    description:
      'Get detailed information about one short link. Identify it by linkId, or by externalId, or by domain and key together (for codeqr.link/github: domain "codeqr.link", key "github"). Pass at least one of those.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        linkId: { type: 'string', description: 'The link ID, as returned by list_links' },
        externalId: { type: 'string', description: 'Your own ID for the link, if you set one' },
        domain: { type: 'string', description: 'The link domain, e.g. "codeqr.link" (use with key)' },
        key: { type: 'string', description: 'The link slug, e.g. "github" (use with domain)' },
      },
    },
  },
  {
    name: 'update_link',
    title: 'Update Short Link',
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
        trackConversion: { type: 'boolean', description: 'Enable conversion tracking for this link (optional; only on plans that include conversion tracking — on other plans the API rejects the entire call. Appends a cq_id attribution parameter to the destination URL)' },
        proxy: { type: 'boolean', description: 'Show a custom social media preview instead of the destination page metadata (optional; set title, description and image in the same call — proxy without them renders an empty preview card)' },
        title: { type: 'string', description: 'Custom preview title (optional; used with proxy, truncated at 120 chars)' },
        description: { type: 'string', description: 'Custom preview description (optional; used with proxy, truncated at 240 chars)' },
        image: { type: 'string', description: 'Custom preview image URL (optional; used with proxy)' },
      },
      required: ['linkId'],
    },
  },
  {
    name: 'delete_link',
    title: 'Delete Short Link',
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
    title: 'Create QR Code',
    annotations: PUBLISHES,
    description:
      'Create a dynamic QR code. It can encode a destination URL, or Wi-Fi credentials, a contact card, a WhatsApp conversation, an email, an SMS, a phone number, plain text or a crypto payment request. The code encodes a short link rather than the content itself, so what it leads to can be changed later with update_qrcode without reprinting anything, and every scan is recorded. Pass the payload field matching the type you choose.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...QRCODE_PAYLOAD_PROPERTIES,
        // `type` is required by the API and has no default of its own. The
        // handler fills 'url' when it is omitted, which keeps the common
        // "make a QR code for this link" call working.
        type: {
          type: 'string',
          enum: QRCODE_CONTENT_TYPES,
          description:
            'What kind of content the QR code encodes. Defaults to "url". Whatever you choose, fill the payload field of the same name.',
        },
        domain: { type: 'string', description: 'Domain for the underlying short link (optional)' },
        key: { type: 'string', description: 'Custom slug for the underlying short link (optional, auto-generated if omitted)' },
        size: { type: 'number', description: 'Size in pixels (optional)' },
        level: { type: 'string', enum: ['L', 'M', 'Q', 'H'], description: 'Error correction level (optional)' },
        fgColor: { type: 'string', description: 'Foreground color hex (optional)' },
        bgColor: { type: 'string', description: 'Background color hex (optional)' },
      },
      // Nothing is required across all nine types. `url` used to be, from when
      // this tool could only make link codes, and leaving it would have made
      // every wifi or vcard call either rejected by a validating client or
      // padded with a URL the model invented. What each type needs is declared
      // on that type's own payload — wifi.ssid, whatsapp.number — and the API
      // enforces the rest.
    },
  },
  {
    name: 'list_qrcodes',
    title: 'List QR Codes',
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
    title: 'Update QR Code',
    annotations: REWRITES_PUBLIC,
    description:
      'Change what a dynamic QR code leads to, without reprinting it: the printed pattern encodes a short link, so copies already distributed now resolve to the new content. Pass the payload field matching the type the code ALREADY has — url for a link code, wifi for a Wi-Fi code, and so on. A code cannot be converted from one type to another here: sending a wifi payload to a url code is accepted and silently changes nothing, so check the type with list_qrcodes first if you are unsure. This does NOT apply to static QR codes, which encode the content directly in the printed pattern — for those, the stored record changes but anything already printed keeps leading to the old content forever. Check whether the code is static before promising the change reaches printed material.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        qrcodeId: { type: 'string', description: 'The QR code ID to update' },
        // The same payloads create accepts. Without them, a wifi or vcard code
        // could be created and then never edited — the one thing a dynamic
        // code exists to allow.
        ...QRCODE_PAYLOAD_PROPERTIES,
        fgColor: { type: 'string', description: 'New foreground color hex (optional)' },
        bgColor: { type: 'string', description: 'New background color hex (optional)' },
        archived: { type: 'boolean', description: 'Archive status (optional)' },
      },
      required: ['qrcodeId'],
    },
  },
  {
    name: 'delete_qrcode',
    title: 'Delete QR Code',
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
    title: 'Get Analytics',
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
        //
        // 'all_unfiltered' is accepted upstream and answers 500 for every
        // groupBy this tool offers. It passes the API's own Zod enum, but the
        // interval-to-window map has no entry for it, so resolving the start
        // date reads a property off undefined. The two branches that would
        // return before that point are keyed on groupBy 'clicks' and 'scans' —
        // the two values this tool deliberately withholds, because they answer
        // 500 as well.
        //
        // The remaining eight all resolve, but the long ones are gated by plan
        // and answer 403 rather than data — so the description names the limits
        // instead of leaving the agent to discover them one rejection at a
        // time. `get_workspace` returns the plan, which is what makes the
        // fallback decidable before the call.
        //
        // Worth recording: 'all_unfiltered' appears in none of the three plan
        // lists, so it is the one value that walks past the gate on any plan.
        // Today it crashes before that matters. Fixing the 500 upstream without
        // adding it to the lists would turn it into a plan-limit bypass.
        interval: {
          type: 'string',
          enum: ['1h', '24h', '7d', '30d', '90d', 'ytd', '1y', 'all'],
          description:
            'Time window to report over (optional, defaults to 24h). Long windows are limited by plan and return 403 above the limit: free stops at 30d, starter at 90d, pro at 1y, business has no limit.',
        },
      },
      required: ['event', 'groupBy'],
    },
  },
  {
    name: 'list_domains',
    title: 'List Custom Domains',
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
    title: 'List Tags',
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
    title: 'Create Tag',
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
    title: 'Get Workspace',
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
 * This is a cast, not a check. `CallToolRequestSchema` validates only the tool
 * name and that the arguments are a record — it does not enforce the tool's
 * own `inputSchema`, so nothing here guarantees the shape at runtime.
 *
 * What it buys is a named type at the call site instead of `any`, which is
 * what `tests/tool-params.test.ts` needs in order to prove at compile time
 * that every advertised property is one the SDK accepts. `any` is why
 * `track_lead` could ship sending `customerId`, a field the API never had.
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
      case 'get_link_info':
        // Cast because the SDK's parameter type is stricter than the endpoint:
        // it demands domain + key + projectSlug, while the route accepts any
        // one identifier and takes the workspace from the credential. The SDK
        // passes the query through unchanged, so the looser call is the one
        // that matches the API's real contract.
        result = await client.links.retrieveInfo(
          args as unknown as Codeqr.LinkRetrieveInfoParams,
        );
        break;
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
      instructions: SERVER_INSTRUCTIONS,
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
