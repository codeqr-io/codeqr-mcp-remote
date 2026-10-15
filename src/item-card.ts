/**
 * The data behind the item card: the widget that shows one QR code or short
 * link in hosts that render MCP Apps (ChatGPT, Claude).
 *
 * A tool result carries it in two places with different readers. Hosts show
 * `structuredContent` to the model as well as to the widget, so it holds a
 * short allowlist of fields: the QR code API returns its whole database row,
 * push token and Wi-Fi password included, and none of that may reach the
 * conversation through here. The image and dashboard URLs only the widget
 * needs go in the result's `_meta`, which hosts keep from the model.
 */

import { asCreatedResource, qrImageUrl, shortLinkOf } from './next-steps.js';

const ITEM_CARD_TOOL_KINDS = {
  create_qrcode: 'qrcode',
  update_qrcode: 'qrcode',
  create_link: 'link',
  update_link: 'link',
  get_link_info: 'link',
} as const;

export type ItemCardTool = keyof typeof ITEM_CARD_TOOL_KINDS;
export type ItemCardKind = (typeof ITEM_CARD_TOOL_KINDS)[ItemCardTool];

/** The tools whose result is a single QR code or link, which is what the card shows. */
export function isItemCardTool(name: string): name is ItemCardTool {
  return Object.hasOwn(ITEM_CARD_TOOL_KINDS, name);
}

export function itemCardKind(tool: ItemCardTool): ItemCardKind {
  return ITEM_CARD_TOOL_KINDS[tool];
}

export type ItemCard = {
  kind: ItemCardKind;
  id: string;
  shortLink: string;
  title: string | null;
  /** The QR code's content type (url, wifi, vcard…); links have none. */
  type?: string;
  isStatic: boolean;
  archived: boolean;
  /** Only where the destination is a URL: any other QR payload is the user's data, not a destination. */
  destination?: string;
  scans?: number;
  clicks?: number;
};

export const ITEM_CARD_META_KEY = 'io.codeqr/card';

export type ItemCardMeta = {
  imageUrl: string;
  editUrl: string;
};

export interface ItemCardUrls {
  slug: string | undefined;
  appUrl: string;
  apiUrl: string;
}

// Where the dashboard stores the rendered design of a QR code, frame included.
const STORED_IMAGE_HOST = 'res.cloudinary.com';

export function buildItemCard(
  kind: ItemCardKind,
  result: unknown,
  { slug, appUrl, apiUrl }: ItemCardUrls,
): { structuredContent: ItemCard; meta: Record<string, ItemCardMeta> } | undefined {
  const created = asCreatedResource(result);
  if (!created) return undefined;
  const row = result as Record<string, unknown>;
  const shortLink = shortLinkOf(created);

  const card: ItemCard = {
    kind,
    id: created.id,
    shortLink,
    title: nonEmptyString(row.title) ?? null,
    ...(kind === 'qrcode' && nonEmptyString(row.type) ? { type: row.type as string } : {}),
    isStatic: created.isStatic,
    archived: row.archived === true,
  };

  const destination = nonEmptyString(row.url);
  if (destination && (kind === 'link' || row.type === 'url')) card.destination = destination;

  const counter = kind === 'qrcode' ? 'scans' : 'clicks';
  if (typeof row[counter] === 'number') card[counter] = row[counter] as number;

  const section = kind === 'qrcode' ? 'qrcodes' : 'links';
  const editUrl = slug
    ? `${appUrl}/${slug}/${section}/edit?id=${encodeURIComponent(created.id)}${kind === 'qrcode' ? '&showDownload=true' : ''}`
    : appUrl;

  return {
    structuredContent: card,
    meta: { [ITEM_CARD_META_KEY]: { imageUrl: imageUrlOf(kind, row, shortLink, apiUrl), editUrl } },
  };
}

/**
 * A QR code's stored image is its real design, frame and logo included, so it
 * is preferred over a fresh render. A link's API response already carries a
 * QR image URL from the public generator. Anything pointing elsewhere is
 * replaced rather than trusted: the widget only loads images from the origins
 * its CSP declares.
 */
function imageUrlOf(kind: ItemCardKind, row: Record<string, unknown>, shortLink: string, apiUrl: string): string {
  if (kind === 'qrcode') {
    const stored = nonEmptyString(row.image);
    if (stored && isHttpsOn(stored, STORED_IMAGE_HOST)) return stored;
  } else {
    const generated = nonEmptyString(row.qrCode);
    if (generated?.startsWith(`${apiUrl}/qr?`)) return generated;
  }
  return qrImageUrl(apiUrl, shortLink);
}

function isHttpsOn(url: string, host: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === host;
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
