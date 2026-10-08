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
  domain: string;
  key: string;
}

export interface NextStepsInput {
  kind: 'qrcode' | 'link';
  created: CreatedResource;
  /** The workspace slug, when it could be read; the dashboard line is left out otherwise. */
  workspaceSlug?: string;
  appUrl: string;
  apiUrl: string;
}

export function shortLinkOf({ domain, key }: CreatedResource): string {
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
    lines.push(`Manage it in CodeQR: ${appUrl}/${workspaceSlug}/${section}/${encodeURIComponent(created.key)}`);
  }
  lines.push(
    kind === 'qrcode'
      ? 'Where it leads can be changed later without reprinting the code: just ask me to update it.'
      : 'Where it leads can be changed later without sharing a new link: just ask me to update it.',
    `Every ${kind === 'qrcode' ? 'scan' : 'click'} is counted: ask me how it is doing at any time.`,
  );

  return lines.join('\n');
}

/** The fields a create response must carry for a note to be written about it. */
export function asCreatedResource(result: unknown): CreatedResource | null {
  if (typeof result !== 'object' || result === null) return null;
  const { domain, key } = result as { domain?: unknown; key?: unknown };
  return typeof domain === 'string' && domain && typeof key === 'string' && key ? { domain, key } : null;
}
