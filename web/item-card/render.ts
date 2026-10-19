/**
 * Turns a tool result into the card. Everything in the result is treated as
 * untrusted: fields are type-checked, text only ever goes through textContent,
 * and only https URLs are used. Which origins images may come from is the
 * host's to enforce, through the CSP the server declares with the template
 * (src/widgets/index.ts), which follows the server's own configuration.
 *
 * Never build markup from a string here (innerHTML and friends): that CSP lets
 * scripts load from the image origins too, Cloudinary included, so an
 * injection would run. tests/item-card-widget.test.ts fails if one appears.
 */

import type { ToolResult } from '../shared/bridge.js';
import { fill, type Strings } from './i18n.js';

export const CARD_META_KEY = 'io.codeqr/card';

type QrType = keyof Strings['types'];

export interface CardView {
  kind: 'qrcode' | 'link';
  shortLink: string;
  title?: string;
  type?: string;
  isStatic: boolean;
  archived: boolean;
  destination?: string;
  count?: number;
  imageUrl?: string;
  editUrl?: string;
}

export interface CardActions {
  openLink(url: string): void;
  sendMessage(text: string): void;
  /** Resolves to whether the text reached the clipboard. */
  copy(text: string): Promise<boolean>;
}

export function toCardView(result: ToolResult | undefined): CardView | null {
  if (!result || result.isError) return null;
  const content = asRecord(result.structuredContent);
  if (!content) return null;

  const kind = content.kind;
  const shortLink = httpsUrl(content.shortLink);
  if ((kind !== 'qrcode' && kind !== 'link') || !shortLink) return null;

  const meta = asRecord(asRecord(result._meta)?.[CARD_META_KEY]);
  const count = kind === 'qrcode' ? content.scans : content.clicks;

  return {
    kind,
    shortLink,
    title: text(content.title),
    type: text(content.type),
    isStatic: content.isStatic === true,
    archived: content.archived === true,
    destination: text(content.destination),
    count: typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : undefined,
    imageUrl: httpsUrl(meta?.imageUrl),
    editUrl: httpsUrl(meta?.editUrl),
  };
}

export function renderCard(
  root: HTMLElement,
  view: CardView | null,
  { strings, locale }: { strings: Strings; locale: string },
  actions: CardActions,
): void {
  root.replaceChildren();
  if (!view) return;

  const shown = withoutScheme(view.shortLink);
  const card = el('article', 'card');

  const typeLabel = view.kind === 'qrcode' && view.type && view.type !== 'url' ? typeName(view.type, strings) : undefined;
  const destination = view.destination ? withoutScheme(view.destination) : undefined;
  // A static code is printed with its content, not its short link, so the card does not offer the link to share.
  const heading = view.title ?? destination ?? typeLabel ?? (view.isStatic ? strings.static : shown);

  if (view.imageUrl) {
    const image = el('img', 'qr');
    image.setAttribute('src', view.imageUrl);
    image.setAttribute('alt', fill(strings.qrAlt, view.isStatic ? heading : shown));
    image.setAttribute('width', '132');
    image.setAttribute('height', '132');
    card.append(image);
  }

  // Without a title, what the code leads to names it best; the short link has its own line below.
  const body = el('div', 'body');
  body.append(el('h2', 'title', heading));

  const badges = el('div', 'badges');
  badges.append(el('span', view.isStatic ? 'badge' : 'badge dynamic', view.isStatic ? strings.static : strings.dynamic));
  if (typeLabel) badges.append(el('span', 'badge', typeLabel));
  if (view.archived) badges.append(el('span', 'badge', strings.archived));
  body.append(badges);

  if (view.title && destination) body.append(el('p', 'destination', destination));

  if (!view.isStatic) {
    const link = el('div', 'link');
    link.append(el('span', 'short', shown));
    const copy = el('button', 'copy', strings.copy);
    copy.setAttribute('type', 'button');
    copy.addEventListener('click', () => {
      void actions.copy(view.shortLink).then((copied) => {
        if (!copied) return;
        copy.textContent = strings.copied;
        setTimeout(() => (copy.textContent = strings.copy), 1_500);
      });
    });
    link.append(copy);
    body.append(link);
  }

  if (view.count !== undefined) {
    const stat = el('div', 'stat');
    stat.append(el('span', 'label', view.kind === 'qrcode' ? strings.scans : strings.clicks));
    stat.append(el('span', 'value', formatCount(view.count, locale)));
    body.append(stat);
  }

  const buttons = el('div', 'actions');
  if (view.editUrl) {
    const editUrl = view.editUrl;
    const open = el('button', 'primary', strings.open);
    open.setAttribute('type', 'button');
    open.addEventListener('click', () => actions.openLink(editUrl));
    buttons.append(open);
  }
  // A static code is never counted, so there is nothing to ask about.
  if (!view.isStatic) {
    const ask = el('button', 'secondary', view.kind === 'qrcode' ? strings.seeScans : strings.seeClicks);
    ask.setAttribute('type', 'button');
    ask.addEventListener('click', () =>
      actions.sendMessage(fill(view.kind === 'qrcode' ? strings.askScans : strings.askClicks, shown)),
    );
    buttons.append(ask);
  }
  if (buttons.childElementCount) body.append(buttons);

  card.append(body);
  root.append(card);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function formatCount(count: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(count);
  } catch {
    return String(count);
  }
}

function typeName(type: string, strings: Strings): string {
  return Object.hasOwn(strings.types, type) ? strings.types[type as QrType] : type;
}

function withoutScheme(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}
