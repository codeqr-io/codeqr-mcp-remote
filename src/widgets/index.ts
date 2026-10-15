/**
 * The item card's template, served as an MCP Apps resource, and the tool
 * metadata that points hosts at it.
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
import { isItemCardTool, type ItemCardTool } from '../item-card.js';
import { ITEM_CARD_HTML } from './generated/item-card.js';

export const WIDGET_MIME_TYPE = 'text/html;profile=mcp-app';
export const ITEM_CARD_URI = 'ui://codeqr/item-card.v1.html';

// Where the dashboard stores the rendered design of each QR code.
const STORED_IMAGE_ORIGIN = 'https://res.cloudinary.com';
const DEFAULT_WIDGET_DOMAIN = 'https://mcp.codeqr.io';

export const WIDGET_RESOURCES = [
  {
    uri: ITEM_CARD_URI,
    name: 'item-card',
    title: 'QR code or short link card',
    description: 'Shows one QR code or short link: its image, short link, destination and scan or click count.',
    mimeType: WIDGET_MIME_TYPE,
  },
];

const INVOCATION_STATUS: Record<ItemCardTool, { invoking: string; invoked: string }> = {
  create_qrcode: { invoking: 'Creating the QR code…', invoked: 'QR code created' },
  update_qrcode: { invoking: 'Updating the QR code…', invoked: 'QR code updated' },
  create_link: { invoking: 'Creating the short link…', invoked: 'Short link created' },
  update_link: { invoking: 'Updating the short link…', invoked: 'Short link updated' },
  get_link_info: { invoking: 'Looking up the link…', invoked: 'Link found' },
};

/** The tool list as advertised: the card's tools point at its template only while the card is switched on. */
export function withWidgetMeta<T extends { name: string }>(tools: readonly T[]): Array<T & { _meta?: Record<string, unknown> }> {
  if (!isUiEnabled()) return [...tools];
  return tools.map((tool) => {
    if (!isItemCardTool(tool.name)) return tool;
    const status = INVOCATION_STATUS[tool.name];
    return {
      ...tool,
      _meta: {
        ui: { resourceUri: ITEM_CARD_URI },
        'openai/outputTemplate': ITEM_CARD_URI,
        'openai/toolInvocation/invoking': status.invoking,
        'openai/toolInvocation/invoked': status.invoked,
      },
    };
  });
}

/** The template's contents, or undefined for a URI this server does not serve. */
export function readWidget(uri: string) {
  if (uri !== ITEM_CARD_URI) return undefined;
  const apiOrigin = new URL(config.codeqrApiUrl).origin;
  const appOrigin = new URL(config.codeqrAppUrl).origin;
  // Hosts apply these to scripts as well as images, which is why the page
  // never turns a string into markup (web/item-card/render.ts).
  const resourceDomains = [STORED_IMAGE_ORIGIN, apiOrigin];

  return {
    contents: [
      {
        uri,
        mimeType: WIDGET_MIME_TYPE,
        text: ITEM_CARD_HTML,
        _meta: {
          ui: {
            csp: { connectDomains: [], resourceDomains },
            prefersBorder: true,
            permissions: { clipboardWrite: {} },
          },
          'openai/widgetDomain': config.serverUrl ? new URL(config.serverUrl).origin : DEFAULT_WIDGET_DOMAIN,
          // Still needed alongside `ui.csp`: only this legacy key lists where
          // ChatGPT may open links from the card.
          'openai/widgetCSP': { connect_domains: [], resource_domains: resourceDomains, redirect_domains: [appOrigin] },
          'openai/widgetPrefersBorder': true,
          'openai/widgetDescription':
            'The card already shows the QR code or link, its short link, destination and count, and a button to open it in CodeQR. Do not repeat those details; suggest what to do next instead.',
        },
      },
    ],
  };
}
