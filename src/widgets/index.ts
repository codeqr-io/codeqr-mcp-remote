/**
 * The cards' templates, served as MCP Apps resources, and the tool metadata
 * that points hosts at them: the item card for one QR code or link, the
 * analytics card for get_analytics.
 *
 * The standard keys (`_meta.ui`) are read by every MCP Apps host; the
 * `openai/` ones only by ChatGPT. `_meta.ui.domain` is deliberately left out:
 * its format is host-specific (Claude expects a `{hash}.claudemcpcontent.com`
 * origin), so the domain goes only in ChatGPT's own alias, which its
 * submission requires.
 *
 * The URI is the hosts' cache key. A change to the page that older tool
 * metadata must not pick up gets a new version in the URI.
 */

import { config, isUiEnabled } from '../config.js';
import { ANALYTICS_HTML } from './generated/analytics.js';
import { ITEM_CARD_HTML } from './generated/item-card.js';

export const WIDGET_MIME_TYPE = 'text/html;profile=mcp-app';
export const ITEM_CARD_URI = 'ui://codeqr/item-card.v1.html';
export const ANALYTICS_URI = 'ui://codeqr/analytics.v1.html';

// Where the dashboard stores the rendered design of each QR code.
const STORED_IMAGE_ORIGIN = 'https://res.cloudinary.com';
const DEFAULT_WIDGET_DOMAIN = 'https://mcp.codeqr.io';

export const WIDGET_DESCRIPTION =
  'The user sees a card for this QR code or short link showing, where they apply, its image, the short link with a ' +
  'copy button, where it leads, its scan or click count, and buttons to open it in CodeQR and to ask how it is doing. ' +
  'Answer what the user asked first. Do not repeat what the card shows (the QR image, short link, destination, count ' +
  'or CodeQR link) and do not build another card, list or table of it; other details, such as smart rules, tags or ' +
  "expiry, are fine to give when they are asked for. Keep the reply short, in the user's language.";

export const ANALYTICS_DESCRIPTION =
  'The user sees a card with these analytics: what is counted and for which period, the total, the trend or the top ' +
  'rows, chips to switch between the last 24 hours, 7 days and 30 days, and a button to open them in CodeQR. Answer ' +
  'what the user asked first. Do not repeat the numbers as a list or table and do not build another chart or card; ' +
  "point out what stands out instead, such as a peak or the leading country. Keep the reply short, in the user's language.";

interface Template {
  uri: string;
  name: string;
  title: string;
  description: string;
  html: string;
  widgetDescription: string;
  /** Origins the page loads from; hosts apply them to scripts as well as images. */
  resourceDomains: () => string[];
  clipboard: boolean;
}

const TEMPLATES: Template[] = [
  {
    uri: ITEM_CARD_URI,
    name: 'item-card',
    title: 'QR code or short link card',
    description: 'Shows one QR code or short link: its image, short link, destination and scan or click count.',
    html: ITEM_CARD_HTML,
    widgetDescription: WIDGET_DESCRIPTION,
    // The page never turns a string into markup, which is what keeps these
    // image origins from becoming script origins (web/item-card/render.ts).
    resourceDomains: () => [STORED_IMAGE_ORIGIN, new URL(config.codeqrApiUrl).origin],
    clipboard: true,
  },
  {
    uri: ANALYTICS_URI,
    name: 'analytics',
    title: 'Analytics card',
    description: 'Shows scans, clicks, leads or sales for a period: the total, the trend or the top rows.',
    html: ANALYTICS_HTML,
    widgetDescription: ANALYTICS_DESCRIPTION,
    // Drawn from the result alone (flags are emoji), so it loads nothing.
    resourceDomains: () => [],
    clipboard: false,
  },
];

export const WIDGET_RESOURCES = TEMPLATES.map(({ uri, name, title, description }) => ({
  uri,
  name,
  title,
  description,
  mimeType: WIDGET_MIME_TYPE,
}));

const TOOL_TEMPLATES: Record<string, { uri: string; invoking: string; invoked: string; callableFromCard?: boolean }> = {
  create_qrcode: { uri: ITEM_CARD_URI, invoking: 'Creating the QR code…', invoked: 'QR code created' },
  update_qrcode: { uri: ITEM_CARD_URI, invoking: 'Updating the QR code…', invoked: 'QR code updated' },
  create_link: { uri: ITEM_CARD_URI, invoking: 'Creating the short link…', invoked: 'Short link created' },
  update_link: { uri: ITEM_CARD_URI, invoking: 'Updating the short link…', invoked: 'Short link updated' },
  get_link_info: { uri: ITEM_CARD_URI, invoking: 'Looking up the link…', invoked: 'Link found' },
  // The analytics card re-runs it for another interval.
  get_analytics: { uri: ANALYTICS_URI, invoking: 'Fetching analytics…', invoked: 'Analytics ready', callableFromCard: true },
};

/** The tool list as advertised: the cards' tools point at their templates only while the cards are switched on. */
export function withWidgetMeta<T extends { name: string }>(tools: readonly T[]): Array<T & { _meta?: Record<string, unknown> }> {
  if (!isUiEnabled()) return [...tools];
  return tools.map((tool) => {
    const template = Object.hasOwn(TOOL_TEMPLATES, tool.name) ? TOOL_TEMPLATES[tool.name] : undefined;
    if (!template) return tool;
    return {
      ...tool,
      _meta: {
        ui: { resourceUri: template.uri, ...(template.callableFromCard ? { visibility: ['model', 'app'] } : {}) },
        'openai/outputTemplate': template.uri,
        'openai/toolInvocation/invoking': template.invoking,
        'openai/toolInvocation/invoked': template.invoked,
        // ChatGPT's own callTool, the card's fallback, refuses a tool without
        // it (default false); ui.visibility covers MCP Apps hosts.
        ...(template.callableFromCard ? { 'openai/widgetAccessible': true } : {}),
      },
    };
  });
}

/** The template's contents, or undefined for a URI this server does not serve. */
export function readWidget(uri: string) {
  const template = TEMPLATES.find((each) => each.uri === uri);
  if (!template) return undefined;
  const appOrigin = new URL(config.codeqrAppUrl).origin;
  const resourceDomains = template.resourceDomains();

  return {
    contents: [
      {
        uri,
        mimeType: WIDGET_MIME_TYPE,
        text: template.html,
        _meta: {
          ui: {
            csp: { connectDomains: [], resourceDomains },
            prefersBorder: true,
            ...(template.clipboard ? { permissions: { clipboardWrite: {} } } : {}),
          },
          'openai/widgetDomain': config.serverUrl ? new URL(config.serverUrl).origin : DEFAULT_WIDGET_DOMAIN,
          // Still needed alongside `ui.csp`: only this legacy key lists where
          // ChatGPT may open links from the card.
          'openai/widgetCSP': { connect_domains: [], resource_domains: resourceDomains, redirect_domains: [appOrigin] },
          'openai/widgetPrefersBorder': true,
          // ChatGPT otherwise tends to render the result a second time from
          // the tool's text, right under the card.
          'openai/widgetDescription': template.widgetDescription,
        },
      },
    ],
  };
}
