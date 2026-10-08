/**
 * The short note appended after a link or QR code is created.
 *
 * The raw API object answers what was stored, not what the person can do
 * with it, and most people who create a code through ChatGPT never come back:
 * the note says where the code lives, that its destination can change after
 * printing, and that its scans can be asked for — the two things a static
 * QR image from anywhere else cannot do.
 *
 * Nothing here may mention a plan, a price or an upgrade: apps in ChatGPT are
 * not allowed to sell subscriptions in the conversation.
 */

export interface CreatedResource {
  id: string;
  domain: string;
  key: string;
  /** A static QR code encodes its destination itself: it can be neither re-pointed nor counted. */
  isStatic: boolean;
}

export interface NextStepsInput {
  kind: 'qrcode' | 'link';
  created: CreatedResource;
  /** The workspace slug, when it could be read; the dashboard line is left out otherwise. */
  workspaceSlug?: string;
  appUrl: string;
  apiUrl: string;
}

export function shortLinkOf({ domain, key }: Pick<CreatedResource, 'domain' | 'key'>): string {
  return `https://${domain}/${key}`;
}

/** CodeQR's public generator, which renders any URL as a QR image. */
export function qrImageUrl(apiUrl: string, target: string): string {
  return `${apiUrl}/qr?url=${encodeURIComponent(target)}`;
}

export function nextStepsText({ kind, created, workspaceSlug, appUrl, apiUrl }: NextStepsInput): string {
  const shortLink = shortLinkOf(created);
  const noun = kind === 'qrcode' ? 'QR code' : 'short link';
  const section = kind === 'qrcode' ? 'qrcodes' : 'links';

  const lines = [`Your ${noun} is live: ${shortLink}`];
  if (kind === 'qrcode') lines.push(`QR image: ${qrImageUrl(apiUrl, shortLink)}`);
  if (workspaceSlug) {
    // The dashboard's own edit page; `/{section}/[key]` is the stats view and
    // needs query parameters the dashboard adds itself.
    lines.push(`Manage it in CodeQR: ${appUrl}/${workspaceSlug}/${section}/edit?id=${encodeURIComponent(created.id)}`);
  }
  if (created.isStatic) {
    lines.push('This is a static code: it holds the destination itself, so it cannot be changed or counted later.');
  } else {
    lines.push(
      kind === 'qrcode'
        ? 'Where it leads can be changed later without reprinting the code: just ask me to update it.'
        : 'Where it leads can be changed later without sharing a new link: just ask me to update it.',
      `Every ${kind === 'qrcode' ? 'scan' : 'click'} is counted: ask me how it is doing at any time.`,
    );
  }

  return lines.join('\n');
}

/** The fields a create response must carry for a note to be written about it. */
export function asCreatedResource(result: unknown): CreatedResource | null {
  if (typeof result !== 'object' || result === null) return null;
  const { id, domain, key } = result as { id?: unknown; domain?: unknown; key?: unknown };
  if (typeof id !== 'string' || !id || typeof domain !== 'string' || !domain || typeof key !== 'string' || !key) {
    return null;
  }
  return { id, domain, key, isStatic: (result as { static?: unknown }).static === true };
}
