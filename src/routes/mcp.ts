/**
 * MCP endpoint handler.
 *
 * Receives authenticated requests (Bearer token from OAuth flow),
 * resolves the user's CodeQR API key, and runs the MCP server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Codeqr from '@codeqr/ts';
import type { Request, Response } from 'express';
import { getWorkspace } from '../codeqr/workspace.js';
import { config, isUiEnabled, SERVER_VERSION } from '../config.js';
import { buildAnalyticsCard } from '../analytics-card.js';
import { resolveAnalyticsQuery } from '../analytics-query.js';
import { buildItemCard, isItemCardTool, itemCardKind } from '../item-card.js';
import {
  DEFAULT_LIST_PAGE_SIZE,
  DOMAINS_MAX_PAGE_SIZE,
  fullPageNote,
  LINKS_MAX_PAGE_SIZE,
  listsNoCustomDomains,
  NO_CUSTOM_DOMAINS_NOTE,
  QRCODES_MAX_PAGE_SIZE,
  TAGS_MAX_PAGE_SIZE,
  withDefaultPageSize,
  withPageSizeInRange,
} from '../list-tools.js';
import { asCreatedResource, nextStepsText } from '../next-steps.js';
import { placeholderDestinationIn, placeholderRefusal } from '../placeholder-destination.js';
import { toClientFacingError } from '../plan-limit-message.js';
import { validateSmartRules, valueDescription } from '../smart-rules.js';
import { hashPrefix, logEvent } from '../telemetry.js';
import {
  DEFAULT_QRCODE_TYPE,
  QRCODE_CONTENT_TYPES,
  STATIC_QRCODE_TYPES,
  WIFI_OPEN_NETWORK,
  WIFI_SECURED_ENCRYPTIONS,
} from '../qrcode-content-types.js';
import { prepareStaticQrCode, STATIC_TYPES_IN_WORDS } from '../static-qrcode.js';
import { toolIntentFields } from '../tool-intent.js';
import { readWidget, WIDGET_RESOURCES, withWidgetMeta } from '../widgets/index.js';

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
 * the printed pattern, which is the static path, and only STATIC_QRCODE_TYPES
 * take that path here; for those, the constructor reads the same names
 * (`lib/utils/functions/qrcode-constructor.ts` and `to-vcard-format.ts` in the
 * CodeQR repo). Where the two disagree, the page wins: it reads
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
const QRCODE_PAYLOAD_PROPERTIES = {
  url: {
    type: 'string',
    description:
      'For type "url": the real destination the person gave. Ask for it if they have not; a placeholder address such as example.com is refused',
  },
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
        enum: [...WIFI_SECURED_ENCRYPTIONS, WIFI_OPEN_NETWORK],
        description: `Security type. Use "${WIFI_OPEN_NETWORK}" for an open network`,
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
      // reads `crypto.email`. A crypto code is never static here, so
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
//
// The directory forbids wording that steers which tool or app the model
// picks, so this only says what the tools do and what they need. Asking for
// the destination comes first because clients may read little past the
// opening of this string.
export const SERVER_INSTRUCTIONS = [
  'You are connected to CodeQR via MCP.',
  'Every short link and dynamic QR code created here is a live endpoint: where it leads can be changed after it has been printed or shared, and its scans and clicks are recorded.',
  'A link, or a QR code that opens a web page, needs the real destination from the person: if they have not given one, ask for it before creating anything. Never invent an address or use a placeholder such as example.com; CodeQR refuses those.',
  'Codes for Wi-Fi, a contact card or plain text need no web address.',
  'Those three can be made static when the person asks: a static code holds its content, so it can never be changed and its scans are not counted.',
  'You can create and update short links and QR codes, read scan and click analytics, and manage domains and tags.',
  'On plans that include it, per-link conversion tracking can be toggled with trackConversion on create_link/update_link, and links can carry a custom social preview (proxy + title/description/image).',
  'Where the workspace has them, a link can carry smart rules: send traffic to different destinations by device, country, city, region, continent, UTM, referrer or language, or split it between 2-4 destinations to run an A/B test — one rule with no condition and a split. A visitor keeps the same variant for an hour, or 30 days when trackConversion is on. Read the value description before setting a condition: device means the operating system, so "mobile" matches nothing.',
  'Recording or querying conversion events (leads, sales) is not available through this connection; link objects do report clicks, leads and sales counters.',
].join(' ');

/**
 * Shared by create_link and update_link, which take the same field.
 *
 * Four of the five invariants cannot be expressed in JSON Schema at all — the
 * weights adding to 100, the url/split exclusivity, the all-or-nothing
 * condition, the unconditional rule having to come last. They live in the
 * descriptions here and are enforced in `validateSmartRules`.
 *
 * `attribute` advertises all twelve the API implements
 * (`SMART_RULE_ATTRIBUTES` in the CodeQR repo, dispatched one by one in
 * `match-smart-rule.ts:33-56`). An earlier revision listed the SDK's seven,
 * reasoning that the other five were a claim nothing verified — which
 * contradicted this same file exposing `split`, a field that SDK type does not
 * have at all. The SDK is behind on both; the API is what answers the call.
 *
 * `value` is generated from `ATTRIBUTE_VALUE_HINTS`, one entry per attribute,
 * so the sentence cannot drift from what the middleware compares. Four
 * attributes are narrower than their names — device (an OS name), region (an
 * ISO 3166-2 code), language (only the ten locales the app serves) and
 * referrer (a bare domain) — and a value outside those sets is not an error
 * anywhere: the API stores it, the validator does not inspect it, and the rule
 * simply never matches. Writing that as prose got it wrong twice; see the
 * table's comment.
 */
const SMART_RULES_SCHEMA = {
  // Nullable because clearing is a first-week request — "end the test, send
  // everyone to the winner" — and the API takes `null` for it
  // (`rules` is `.nullish()`). Declaring only `array` would have a client that
  // validates arguments reject the one value that does the job.
  type: ['array', 'null'] as const,
  description:
    'Conditional destination routing, evaluated in order — the first matching rule wins (optional; not enabled on every workspace, and where it is not the API rejects the entire call). Each rule either sends traffic to one url, or divides it between 2-4 split variants whose weights add up to 100 — never both. A condition is attribute + operator + value together; a rule with no condition matches all traffic, so it must be the last rule and must split. An A/B test is one rule with no condition and a split. Set to null to remove every rule and send all traffic to the link url — on update_link, that is how a running test is ended.',
  maxItems: 20,
  items: {
    type: 'object' as const,
    description:
      'One routing rule: an optional condition, plus a destination that is either a url or a split.',
    properties: {
      attribute: {
        type: 'string' as const,
        description:
          'Request attribute to test (optional; required together with operator and value). Omit all three to match all traffic.',
        enum: [
          'device',
          'country',
          'utm_source',
          'utm_medium',
          'utm_campaign',
          'referrer',
          'language',
          'city',
          'region',
          'continent',
          'utm_term',
          'utm_content',
        ],
      },
      operator: {
        type: 'string' as const,
        description: 'How to compare the attribute against value',
        enum: ['equals', 'not_equals'],
      },
      value: {
        type: 'string' as const,
        description: valueDescription(),
      },
      url: {
        type: 'string' as const,
        description:
          'Destination for traffic matching this rule. Mutually exclusive with split.',
      },
      split: {
        type: 'array' as const,
        description:
          'Divide matching traffic between 2-4 destinations. Mutually exclusive with url. A visitor keeps the same variant across visits, for one hour, or 30 days when trackConversion is on.',
        minItems: 2,
        maxItems: 4,
        items: {
          type: 'object' as const,
          description: 'One variant of the split',
          properties: {
            url: { type: 'string' as const, description: 'Destination for this variant' },
            weight: {
              type: 'integer' as const,
              description:
                'Share of traffic for this variant, 1-100. The weights of a split must add up to exactly 100.',
              minimum: 1,
              maximum: 100,
            },
          },
          required: ['url', 'weight'],
        },
      },
    },
  },
};

/**
 * Shared by create_qrcode and update_qrcode, which take the same field.
 *
 * Nullable because reverting to the workspace's own branding is a real
 * request, and the API takes `null` for it (`walletPassSchema` in
 * lib/zod/schemas/qrcodes.ts of the API repo is nullish on create, nullable
 * on update).
 */
const WALLET_PASS_SCHEMA = {
  type: ['object', 'null'] as const,
  description:
    'Brand the wallet pass saved from this QR code with a name, logo and barcode text of your own, in place of the workspace ones (optional; omit or set to null for no override, which uses the workspace branding). Custom branding is only available on plans that include it, and never during a trial: a new non-null value is rejected with 403 forbidden on any other plan or during a trial, while null (clearing it) is always accepted. Outside those plans, or during a trial, a stored value is ignored when the pass is built, so passes fall back to the workspace name and logo. On update_qrcode: omitting walletPass keeps the value already stored, null clears it, and an object replaces it as a whole — a field left out of the object is cleared, not merged, so send name, logo and barcodeText together to keep all three.',
  properties: {
    name: {
      type: 'string' as const,
      // Mirrors WALLET_PASS_NAME_MAX_LENGTH in lib/zod/schemas/qrcodes.ts of the API repo.
      maxLength: 64,
      description:
        'Name shown at the top of the pass, in place of the workspace name. 1-64 characters after trimming.',
    },
    logo: {
      type: 'string' as const,
      // 2 MB mirrors LOGO_MAX_BYTES in lib/zod/schemas/logo-upload.ts of the API repo.
      description:
        'https URL of a PNG, JPEG or WebP image, up to 2 MB. The API downloads it and stores its own copy; the response returns the URL of that copy, not the URL sent.',
    },
    barcodeText: {
      type: 'string' as const,
      // Mirrors WALLET_PASS_BARCODE_TEXT_MAX_LENGTH in lib/zod/schemas/qrcodes.ts of the API repo.
      maxLength: 40,
      description:
        'Text shown under the QR code on the pass, e.g. a member name or card number. 1-40 characters after trimming. When omitted, CodeQR sends no text for that line — the title is never repeated there.',
    },
  },
};

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
        url: {
          type: 'string',
          description:
            'The destination URL to shorten: the real address the person gave. Ask for it if they have not; a placeholder address such as example.com is refused',
        },
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
        rules: SMART_RULES_SCHEMA,
      },
      required: ['url'],
    },
  },
  {
    name: 'list_links',
    title: 'List Short Links',
    annotations: READ_ONLY,
    description: `List the short links in your CodeQR workspace, newest first, one page at a time (${DEFAULT_LIST_PAGE_SIZE} per page unless pageSize says otherwise).`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Search keyword (optional)' },
        domain: { type: 'string', description: 'Filter by domain (optional)' },
        tagId: { type: 'string', description: 'Filter by tag ID (optional)' },
        page: { type: 'number', description: 'Page number, starting at 1 (optional)' },
        pageSize: {
          type: 'number',
          minimum: 1,
          maximum: LINKS_MAX_PAGE_SIZE,
          description: `Results per page (optional, defaults to ${DEFAULT_LIST_PAGE_SIZE})`,
        },
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
        url: {
          type: 'string',
          description: 'New destination URL (optional; a placeholder address such as example.com is refused)',
        },
        key: { type: 'string', description: 'New slug (optional)' },
        archived: { type: 'boolean', description: 'Archive status (optional)' },
        expiresAt: { type: 'string', description: 'New expiration date (optional)' },
        comments: { type: 'string', description: 'Updated comments (optional)' },
        trackConversion: { type: 'boolean', description: 'Enable conversion tracking for this link (optional; only on plans that include conversion tracking — on other plans the API rejects the entire call. Appends a cq_id attribution parameter to the destination URL)' },
        proxy: { type: 'boolean', description: 'Show a custom social media preview instead of the destination page metadata (optional; set title, description and image in the same call — proxy without them renders an empty preview card)' },
        title: { type: 'string', description: 'Custom preview title (optional; used with proxy, truncated at 120 chars)' },
        description: { type: 'string', description: 'Custom preview description (optional; used with proxy, truncated at 240 chars)' },
        image: { type: 'string', description: 'Custom preview image URL (optional; used with proxy)' },
        rules: SMART_RULES_SCHEMA,
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
      `Create a QR code. It can encode a destination URL, or Wi-Fi credentials, a contact card, a WhatsApp conversation, an email, an SMS, a phone number, plain text or a crypto payment request. By default the code is dynamic: it encodes a short link rather than the content itself, so what it leads to can be changed later with update_qrcode without reprinting anything, and every scan is recorded. A ${STATIC_TYPES_IN_WORDS} code can be made static instead, when the person asks for one (see static). Pass the payload field matching the type you choose. Use walletPass to brand the wallet pass saved from the code with your own name and logo instead of the workspace ones.`,
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
        title: {
          type: 'string',
          description:
            'Title of the QR code. Also shown in large type on the Google/Apple Wallet pass saved from it, replacing "QR Code" (optional).',
        },
        static: {
          type: 'boolean',
          description: `Encode the content itself instead of a short link (optional; only for type ${STATIC_TYPES_IN_WORDS}). A static code works with no CodeQR link in between, but once shared or printed it can never be changed and its scans are not counted. Leave it out unless the person asks for a static code. A static wifi code needs wifi.encryption, and wifi.password unless the network is open.`,
        },
        walletPass: WALLET_PASS_SCHEMA,
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
    description: `List the QR codes in your workspace, newest first, one page at a time (${DEFAULT_LIST_PAGE_SIZE} per page unless pageSize says otherwise).`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        page: { type: 'number', description: 'Page number, starting at 1 (optional)' },
        pageSize: {
          type: 'number',
          minimum: 1,
          maximum: QRCODES_MAX_PAGE_SIZE,
          description: `Results per page (optional, defaults to ${DEFAULT_LIST_PAGE_SIZE})`,
        },
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
        title: {
          type: 'string',
          description:
            'New title of the QR code. Also shown in large type on the Google/Apple Wallet pass saved from it, replacing "QR Code" (optional).',
        },
        walletPass: WALLET_PASS_SCHEMA,
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
        // The remaining eight all resolve, but the long ones are gated and
        // answer 403 rather than data. The description says that without
        // naming the tiers or their ceilings: a client can show this text to
        // the end user, and the directory reads a tier list as an upsell. The
        // rewritten 403 says to retry shorter, which is the whole decision.
        //
        // Worth recording: 'all_unfiltered' appears in none of the three plan
        // lists, so it is the one value that walks past the gate on any plan.
        // Today it crashes before that matters. Fixing the 500 upstream without
        // adding it to the lists would turn it into a plan-limit bypass.
        interval: {
          type: 'string',
          enum: ['1h', '24h', '7d', '30d', '90d', 'ytd', '1y', 'all'],
          description:
            'Time window to report over (optional, defaults to 24h). Long windows are not available to every workspace and return 403 rather than data; when that happens, a shorter interval returns the report.',
        },
      },
      required: ['event', 'groupBy'],
    },
  },
  {
    name: 'list_domains',
    title: 'List Custom Domains',
    annotations: READ_ONLY,
    description:
      "List the custom domains configured in your workspace. Shared short domains are not listed; leaving domain out when creating a link or QR code uses the workspace's default.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Search keyword (optional)' },
        page: { type: 'number', description: 'Page number (optional)' },
        pageSize: {
          type: 'number',
          minimum: 1,
          maximum: DOMAINS_MAX_PAGE_SIZE,
          description: 'Results per page (optional)',
        },
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
        pageSize: {
          type: 'number',
          minimum: 1,
          maximum: TAGS_MAX_PAGE_SIZE,
          description: 'Results per page (optional)',
        },
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

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}

/** How a tool call ended, for telemetry; never sent to the client. */
export type ToolOutcome =
  | 'ok'
  | 'invalid_arguments'
  | 'placeholder_destination'
  | 'unknown_tool'
  | 'plan_limit'
  | 'api_error';

/**
 * Exported for the tests. The argument-validation branch is only meaningful at
 * this call site: a unit test of `validateSmartRules` passes just as happily
 * when nothing calls it, so the check that matters is that an invalid payload
 * never reaches `client`.
 */
export async function handleToolCall(
  client: Codeqr,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
  onOutcome?: (outcome: ToolOutcome) => void,
): Promise<ToolResult> {
  const placeholder = placeholderDestinationIn(name, args);
  if (placeholder) {
    onOutcome?.('placeholder_destination');
    return { content: [{ type: 'text', text: `Error: ${placeholderRefusal(placeholder)}` }], isError: true };
  }

  try {
    let result: unknown;
    // The arguments the card describes; get_analytics resolves a code named by domain and key.
    let cardArgs = args;
    // What list_links and list_qrcodes asked the API for, page size included.
    let listArgs: Record<string, unknown> | undefined;

    switch (name) {
      case 'create_link': {
        // Saves the round-trip, and answers in a sentence rather than the
        // serialized error body the SDK would surface. See smart-rules.ts.
        const invalid = validateSmartRules(args.rules);
        if (invalid) {
          onOutcome?.('invalid_arguments');
          return { content: [{ type: 'text', text: `Error: ${invalid}` }], isError: true };
        }
        result = await client.links.create(asParams<Codeqr.LinkCreateParams>(args));
        break;
      }
      case 'list_links':
        listArgs = withPageSizeInRange(withDefaultPageSize(args, DEFAULT_LIST_PAGE_SIZE), LINKS_MAX_PAGE_SIZE);
        result = await client.links.list(asParams<Codeqr.LinkListParams>(listArgs));
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
        const invalid = validateSmartRules(args.rules);
        if (invalid) {
          onOutcome?.('invalid_arguments');
          return { content: [{ type: 'text', text: `Error: ${invalid}` }], isError: true };
        }
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
      case 'create_qrcode': {
        const prepared = prepareStaticQrCode(args);
        if ('error' in prepared) {
          onOutcome?.('invalid_arguments');
          return { content: [{ type: 'text', text: `Error: ${prepared.error}` }], isError: true };
        }
        // `type` is required upstream with no default of its own. Filling it
        // here keeps the common "make a QR code for this URL" call working
        // instead of failing validation before anything is created.
        result = await client.qrcodes.create(
          asParams<Codeqr.QrcodeCreateParams>({ type: DEFAULT_QRCODE_TYPE, ...prepared.args }),
        );
        break;
      }
      case 'list_qrcodes':
        listArgs = withPageSizeInRange(withDefaultPageSize(args, DEFAULT_LIST_PAGE_SIZE), QRCODES_MAX_PAGE_SIZE);
        result = await client.qrcodes.list(asParams<Codeqr.QrcodeListParams>(listArgs));
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
      case 'get_analytics': {
        const resolved = await resolveAnalyticsQuery(client, args);
        if ('error' in resolved) {
          onOutcome?.('invalid_arguments');
          return { content: [{ type: 'text', text: `Error: ${resolved.error}` }], isError: true };
        }
        cardArgs = resolved.cardArgs;
        result = await client.analytics.retrieve(asParams<Codeqr.AnalyticsRetrieveParams>(resolved.request));
        break;
      }
      // Both of these used to be called with no arguments at all, so `page`
      // and `pageSize` never reached the API and a workspace with more items
      // than one page reported a truncated list as if it were complete.
      case 'list_domains':
        result = await client.domains.list(
          asParams<Codeqr.DomainListParams>(withPageSizeInRange(args, DOMAINS_MAX_PAGE_SIZE)),
        );
        break;
      case 'list_tags':
        result = await client.tags.list(
          asParams<Codeqr.TagListParams>(withPageSizeInRange(args, TAGS_MAX_PAGE_SIZE)),
        );
        break;
      case 'create_tag':
        result = await client.tags.create(asParams<Codeqr.TagCreateParams>(args));
        break;
      case 'get_workspace':
        result = await getWorkspace(apiKey);
        break;
      default:
        onOutcome?.('unknown_tool');
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    onOutcome?.('ok');
    const response = await withCreatedNoteAndCard(name, cardArgs, result, apiKey);
    if (name === 'list_domains' && listsNoCustomDomains(args, result)) {
      response.content.push({ type: 'text', text: NO_CUSTOM_DOMAINS_NOTE });
    }
    const morePages = listArgs && fullPageNote(listArgs, result);
    if (morePages) response.content.push({ type: 'text', text: morePages });
    return response;
  } catch (error) {
    // Every tool funnels through here, which is why the rewrite lives at this
    // one point rather than per tool. The `Error:` prefix is kept for every
    // class alike, a plan gate included: the two local validation branches
    // above carry it too, and a text format that varies with the class of
    // failure is one more thing the next reader has to discover.
    const { message, isPlanLimit } = toClientFacingError(error, { tool: name, args });
    onOutcome?.(isPlanLimit ? 'plan_limit' : 'api_error');
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
    logEvent('mcp.rejected', { status: 401, reason: 'no_api_key', clientId: req.oauthClientId });
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
  const uiEnabled = isUiEnabled();
  const server = new McpServer(
    { name: 'codeqr', version: SERVER_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
      // `resources` serves the item card's template (widgets/index.ts), and
      // is declared only while the card is on: off, the handshake is what it was.
      capabilities: uiEnabled ? { tools: {}, resources: {} } : { tools: {} },
    },
  );

  // Create CodeQR client with the user's API key
  const client = new Codeqr({ apiKey });

  // Register tool handlers on the underlying server
  const innerServer = server.server;

  innerServer.setRequestHandler(ListToolsRequestSchema, async () => {
    logEvent('mcp.tools_list', { clientId: req.oauthClientId, keyHashPrefix: req.keyHashPrefix });
    return { tools: withWidgetMeta(TOOLS) };
  });

  // No CodeQR call in these, on purpose: a host may fetch the template before
  // any tool runs, and the workspace lookup would record a first use that
  // never happened (InstalledIntegration.firstUsedAt).
  if (uiEnabled) {
    innerServer.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: WIDGET_RESOURCES }));
    innerServer.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
    innerServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      const widget = readWidget(uri);
      logEvent('mcp.resource_read', {
        clientId: req.oauthClientId,
        keyHashPrefix: req.keyHashPrefix,
        resource: uri,
        outcome: widget ? 'ok' : 'error',
      });
      if (!widget) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
      return widget;
    });
  }

  innerServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startedAt = Date.now();
    let outcome = 'api_error' as ToolOutcome;
    const result = await handleToolCall(client, apiKey, name, args as Record<string, unknown>, (ended) => {
      outcome = ended;
    });
    logEvent('mcp.tool_call', {
      clientId: req.oauthClientId,
      keyHashPrefix: req.keyHashPrefix,
      tool: name,
      outcome: outcome === 'ok' ? 'ok' : 'error',
      reason: outcome === 'ok' ? undefined : outcome,
      durationMs: Date.now() - startedAt,
      ...openaiMetaFields(request.params._meta),
      ...toolIntentFields(name, args as Record<string, unknown> | undefined),
    });
    return result;
  });

  // The transport answers malformed requests itself (wrong Accept header, bad
  // JSON-RPC, unsupported protocol version) without reaching the handlers
  // above, and the only account of why is the JSON-RPC error it writes as the
  // body — through `write`, then an empty `end`. Both are wrapped to keep what
  // an error response carries; nothing else about the response changes.
  let errorBody = '';
  const keepErrorBody = (chunk: unknown) => {
    if (res.statusCode < 400 || errorBody.length >= MAX_ERROR_BODY_LENGTH) return;
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
      errorBody += Buffer.from(chunk).toString('utf8').slice(0, MAX_ERROR_BODY_LENGTH - errorBody.length);
    }
  };
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  res.write = ((...args: unknown[]) => {
    keepErrorBody(args[0]);
    return write(...args);
  }) as Response['write'];
  const end = res.end.bind(res) as (...args: unknown[]) => Response;
  res.end = ((...args: unknown[]) => {
    keepErrorBody(args[0]);
    return end(...args);
  }) as Response['end'];

  const initialize = initializeParams(req.body);

  res.on('finish', () => {
    if (res.statusCode < 400) {
      if (initialize) {
        logEvent('mcp.initialize', {
          clientId: req.oauthClientId,
          keyHashPrefix: req.keyHashPrefix,
          protocolVersion: stringOrUndefined(initialize.protocolVersion),
          clientName: stringOrUndefined(initialize.clientInfo?.name),
          clientVersion: stringOrUndefined(initialize.clientInfo?.version),
          userAgent: req.headers['user-agent'],
        });
      }
      return;
    }
    logEvent('mcp.rejected', {
      status: res.statusCode,
      reason: 'transport',
      rpcError: rpcError(errorBody),
      clientId: req.oauthClientId,
      userAgent: req.headers['user-agent'],
      rpcMethod: rpcMethods(req.body),
      accept: req.headers.accept,
      protocolVersion: headerValue(req.headers['mcp-protocol-version']),
      hasSession: Boolean(req.headers['mcp-session-id']),
    });
  });

  // Handle the request via StreamableHTTP transport
  const transport = new StreamableHTTPServerTransport();
  await server.connect(transport as any);
  await transport.handleRequest(req, res, req.body);
}

/**
 * The JSON of the result, plus the note after a create and, where the cards
 * are switched on, the item card's or the analytics card's data. Both need the workspace slug, which is
 * one extra call to CodeQR, so it is looked up once for the two; when the
 * lookup fails the dashboard line and the card's dashboard link fall back
 * rather than failing a call that already succeeded.
 */
async function withCreatedNoteAndCard(
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  apiKey: string,
): Promise<ToolResult> {
  const content: ToolResult['content'] = [{ type: 'text', text: JSON.stringify(result, null, 2) }];

  if (name === 'get_analytics' && isUiEnabled()) {
    const card = buildAnalyticsCard(args, result, {
      slug: await lookupWorkspaceSlug(apiKey),
      appUrl: config.codeqrAppUrl,
    });
    return card ? { content, structuredContent: card.structuredContent, _meta: card.meta } : { content };
  }

  const created = asCreatedResource(result);
  const isCreate = name === 'create_qrcode' || name === 'create_link';
  const cardTool = isUiEnabled() && isItemCardTool(name) ? name : undefined;
  if (!created || (!isCreate && !cardTool)) return { content };

  const workspaceSlug = await lookupWorkspaceSlug(apiKey);
  const urls = { appUrl: config.codeqrAppUrl, apiUrl: config.codeqrApiUrl };

  if (isCreate) {
    content.push({
      type: 'text',
      text: nextStepsText({ kind: name === 'create_qrcode' ? 'qrcode' : 'link', created, workspaceSlug, ...urls }),
    });
  }
  const card = cardTool && buildItemCard(itemCardKind(cardTool), result, { slug: workspaceSlug, ...urls });
  return card ? { content, structuredContent: card.structuredContent, _meta: card.meta } : { content };
}

async function lookupWorkspaceSlug(apiKey: string): Promise<string | undefined> {
  return Promise.race([
    getWorkspace(apiKey).then(
      (workspace) => workspace.slug,
      () => undefined,
    ),
    new Promise<undefined>((resolve) => {
      AbortSignal.timeout(SLUG_LOOKUP_TIMEOUT_MS).addEventListener('abort', () => resolve(undefined));
    }),
  ]);
}

/**
 * The code is already created when the slug is looked up, so a slow CodeQR
 * should cost the note its dashboard line, not delay the answer by the
 * lookup's own 10-second timeout.
 */
export const SLUG_LOOKUP_TIMEOUT_MS = 1_500;

const MAX_ERROR_BODY_LENGTH = 2_000;

function rpcError(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const error = (JSON.parse(body) as { error?: { code?: unknown; message?: unknown } }).error;
    if (error && (typeof error.code === 'number' || typeof error.message === 'string')) {
      return `${error.code ?? ''} ${error.message ?? ''}`.trim();
    }
  } catch {
    // Not JSON: report that rather than the raw body.
  }
  return 'unparsed_body';
}

function rpcMethods(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? body : [body];
  const methods = messages
    .map((message) => (typeof message === 'object' && message !== null ? (message as { method?: unknown }).method : undefined))
    .filter((method): method is string => typeof method === 'string');
  return methods.length > 0 ? methods.join(',') : undefined;
}

const stringOrUndefined = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

interface InitializeParams {
  protocolVersion?: unknown;
  clientInfo?: { name?: unknown; version?: unknown };
}

function initializeParams(body: unknown): InitializeParams | undefined {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const { method, params } = message as { method?: unknown; params?: unknown };
    if (method === 'initialize') {
      return typeof params === 'object' && params !== null ? (params as InitializeParams) : {};
    }
  }
  return undefined;
}

/** Keys per OpenAI's Apps SDK `_meta`; both are optional and other clients send neither. */
function openaiMetaFields(meta: Record<string, unknown> | undefined) {
  const session = meta?.['openai/session'];
  return {
    openaiUserAgent: stringOrUndefined(meta?.['openai/userAgent']),
    sessionHash: typeof session === 'string' && session !== '' ? hashPrefix(session) : undefined,
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}
