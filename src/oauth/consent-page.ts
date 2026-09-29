/**
 * The consent screen this server shows before sending anyone to CodeQR.
 *
 * CodeQR's own screen names the app it knows about — this server, "CodeQR
 * MCP" — never the MCP client that registered here, so it cannot tell the user
 * where the access will end up. This page does: the client's self-declared
 * name, flagged as unverified, and the host its redirect_uri points at.
 */

import type { Response } from 'express';

const SCOPE_LABELS: Record<string, string> = {
  'links.read': 'View your short links',
  'links.write': 'Create, change and delete short links',
  'qrcodes.read': 'View your QR codes',
  'qrcodes.write': 'Create, change and delete QR codes',
  'analytics.read': 'View scan and click analytics',
  'domains.read': 'View your domains',
  'tags.read': 'View your tags',
  'tags.write': 'Create and change tags',
};

// Bidi overrides let a name like "Claude‮moc.evil" render as something else.
const INVISIBLE_FORMATTING = /[‎‏‪-‮⁦-⁩]/g;

export interface ConsentPageParams {
  clientName: string;
  redirectUri: string;
  scopes: readonly string[];
  /** Echoed back as hidden inputs so the form submission can be re-validated. */
  fields: Record<string, string | undefined>;
}

export function sendConsentPage(res: Response, params: ConsentPageParams): void {
  res
    .status(200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      // form-action is left out on purpose: browsers apply it to the redirect
      // after submit, which goes to CodeQR or to the client's own redirect_uri.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    })
    .send(renderConsentPage(params));
}

export function renderConsentPage({ clientName, redirectUri, scopes, fields }: ConsentPageParams): string {
  const name = escapeHtml(clientName.replace(INVISIBLE_FORMATTING, '').trim());
  const destination = describeDestination(redirectUri);

  const hiddenInputs = Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join('\n      ');

  const scopeItems = scopes
    .map((scope) => `<li>${escapeHtml(SCOPE_LABELS[scope] ?? scope)}</li>`)
    .join('\n        ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Connect an app to CodeQR</title>
  <style>
    :root { color-scheme: light dark; --fg: #111827; --muted: #4b5563; --bg: #f9fafb; --card: #fff; --line: #e5e7eb; --warn-bg: #fffbeb; --warn-fg: #92400e; --accent: #111827; --accent-fg: #fff; }
    @media (prefers-color-scheme: dark) { :root { --fg: #f3f4f6; --muted: #9ca3af; --bg: #0b0f19; --card: #111827; --line: #1f2937; --warn-bg: #3a2a07; --warn-fg: #fcd34d; --accent: #f3f4f6; --accent-fg: #111827; } }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0 16px; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); }
    main { max-width: 460px; margin: 6vh auto; padding: 28px 24px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; }
    h1 { font-size: 20px; line-height: 1.3; margin: 0 0 16px; overflow-wrap: anywhere; }
    h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 20px 0 6px; }
    .warn { background: var(--warn-bg); color: var(--warn-fg); border-radius: 8px; padding: 10px 12px; margin: 0; }
    .target { font-size: 18px; font-weight: 700; margin: 0; overflow-wrap: anywhere; }
    .note { color: var(--muted); margin: 4px 0 0; }
    .uri { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); margin: 6px 0 0; overflow-wrap: anywhere; }
    ul { margin: 0; padding-left: 20px; }
    .actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; }
    button { font: inherit; font-weight: 600; padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
    button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  </style>
</head>
<body>
  <main>
    <h1>Connect <strong>${name}</strong> to your CodeQR account?</h1>
    <p class="warn">“${name}” is the name the app gave itself; CodeQR has not verified it. Continue only if you started this connection yourself. If someone sent you this link, cancel.</p>

    <h2>Access will be sent to</h2>
    <p class="target">${escapeHtml(destination.target)}</p>
    ${destination.note ? `<p class="note">${escapeHtml(destination.note)}</p>` : ''}
    <p class="uri">${escapeHtml(redirectUri)}</p>

    <h2>After you sign in and pick a project, it will be able to</h2>
    <ul>
        ${scopeItems}
    </ul>

    <form method="post" action="authorize">
      ${hiddenInputs}
      <div class="actions">
        <button type="submit" name="decision" value="deny">Cancel</button>
        <button type="submit" name="decision" value="approve" class="primary">Continue to CodeQR</button>
      </div>
    </form>
  </main>
</body>
</html>
`;
}

function describeDestination(redirectUri: string): { target: string; note?: string } {
  const url = new URL(redirectUri);

  if (url.protocol === 'https:') return { target: url.host };

  if (url.protocol === 'http:') {
    return {
      target: url.host,
      note: 'This address is on your own computer, so any program running on it can receive the access.',
    };
  }

  return {
    target: url.host ? `${url.protocol}//${url.host}` : url.protocol,
    note: 'This address opens an app installed on this device.',
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
