/**
 * The consent screen this server shows before sending anyone to CodeQR.
 *
 * CodeQR's own screen names the app it knows about — this server, "CodeQR
 * MCP" — never the MCP client that registered here, so it cannot tell the user
 * where the access will end up. This page does: the client's self-declared
 * name, flagged as unverified, and the host its redirect_uri points at.
 *
 * The layout, colors and wording follow CodeQR's authorize screen
 * (app/app.codeqr.io/(auth)/oauth/authorize in the main repo), so the two
 * screens the user passes through read as one flow.
 */

import type { Response } from 'express';
import { CODEQR_LOGO_DATA_URI } from './codeqr-logo.js';

// Same wording as OAUTH_SCOPE_DESCRIPTIONS in the main repo, so both screens
// describe the access the same way.
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'links.read': 'Read access to your links',
  'links.write': 'Read and write access to your links',
  'qrcodes.read': 'Read access to your QR Codes',
  'qrcodes.write': 'Read and write access to your QR Codes',
  'analytics.read': 'Read access to your analytics and events',
  'domains.read': 'Read access to your domains',
  'tags.read': 'Read access to your tags',
  'tags.write': 'Read and write access to your tags',
  'user.read': 'Read your name, email, and profile picture',
};

// Bidi overrides let a name like "Claude‮moc.evil" render as something else.
const INVISIBLE_FORMATTING = /[‎‏‪-‮⁦-⁩]/g;

const ARROW_LEFT_RIGHT_ICON =
  '<svg class="arrows" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>';

const CHECK_ICON =
  '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const WARNING_ICON =
  '<svg class="warning" viewBox="0 0 18 18" aria-hidden="true"><g fill="currentColor"><circle cx="9" cy="9" r="7.25" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><line x1="9" x2="9" y1="5.431" y2="9.569" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/><path d="M9,13.417c-.552,0-1-.449-1-1s.448-1,1-1,1,.449,1,1-.448,1-1,1Z" stroke="none"/></g></svg>';

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
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    })
    .send(renderConsentPage(params));
}

export function renderConsentPage({ clientName, redirectUri, scopes, fields }: ConsentPageParams): string {
  const displayName = clientName.replace(INVISIBLE_FORMATTING, '').trim();
  const name = escapeHtml(displayName);
  const initial = escapeHtml((Array.from(displayName)[0] ?? '?').toUpperCase());
  const destination = describeDestination(redirectUri);

  const hiddenInputs = Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join('\n        ');

  const scopeItems = consolidateScopes([...scopes, 'user.read'])
    .map((scope) => {
      const description = escapeHtml(SCOPE_DESCRIPTIONS[scope] ?? scope)
        .replace('Write', '<strong>Write</strong>')
        .replace('Read', '<strong>Read</strong>');
      return `<li>${CHECK_ICON}<span>${description}</span></li>`;
    })
    .join('\n          ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Authorize API Access | CodeQR</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html { font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.5; -webkit-font-smoothing: antialiased; }
    body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; padding: 48px 0; color: #000; background-color: #eff6ff; background-image: linear-gradient(to right, #8080800a 1px, transparent 1px), linear-gradient(to bottom, #8080800a 1px, transparent 1px); background-size: 14px 24px; }
    .card { margin: auto; width: 100%; max-width: 28rem; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; }
    .header { display: flex; flex-direction: column; align-items: center; gap: .75rem; padding: 2rem 1rem 1.5rem; background: #fff; border-bottom: 1px solid #e5e7eb; text-align: center; }
    .logos { display: flex; align-items: center; gap: .75rem; }
    .avatar { display: flex; align-items: center; justify-content: center; width: 48px; height: 48px; border: 1px solid #e5e7eb; border-radius: 9999px; background: #f3f4f6; color: #4b5563; font-size: 1.25rem; font-weight: 600; }
    .logo { display: block; width: 48px; height: 48px; }
    .arrows { width: 20px; height: 20px; color: #6b7280; }
    .request { margin: 0; overflow-wrap: anywhere; }
    .request b { font-weight: 700; }
    .badge { display: flex; align-items: center; gap: .5rem; padding: .5rem; border-radius: .375rem; background: #fefce8; color: #a16207; font-size: .875rem; line-height: 1.5rem; text-align: left; }
    .warning { flex-shrink: 0; width: 16px; height: 16px; }
    .section { display: flex; flex-direction: column; gap: .75rem; padding: 1.5rem .5rem; background: #fff; }
    .section + .section { border-top: 1px solid #e5e7eb; }
    .label { color: #4b5563; }
    .target { margin: 0; font-size: 1.125rem; font-weight: 700; overflow-wrap: anywhere; }
    .note { margin: -.5rem 0 0; color: #6b7280; font-size: .875rem; line-height: 1.5rem; }
    .uri { margin: -.5rem 0 0; color: #6b7280; font: .75rem/1rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    ul { margin: 0; padding: 0; list-style: none; }
    li { display: flex; align-items: center; gap: .5rem; }
    li + li { margin-top: .25rem; }
    li strong { font-weight: 500; }
    .check { flex-shrink: 0; width: 16px; height: 16px; color: #22c55e; }
    .footer { padding: 1.5rem .5rem; background: #fff; border-top: 1px solid #e5e7eb; }
    .hint { margin: 0; color: #6b7280; font-size: .875rem; line-height: 1.5rem; }
    .actions { display: flex; justify-content: space-between; gap: 1rem; margin-top: 1rem; }
    button { display: flex; align-items: center; justify-content: center; height: 2.5rem; padding: 0 1rem; border: 1px solid; border-radius: .375rem; font: inherit; font-size: .875rem; line-height: 1.5rem; white-space: nowrap; cursor: pointer; transition: all .15s; }
    .secondary { border-color: #e5e7eb; background: #fff; color: #111827; }
    .secondary:hover { background: #f9fafb; }
    .primary { border-color: #000; background: #000; color: #fff; }
    .primary:hover { background: #1f2937; box-shadow: 0 0 0 4px #e5e7eb; }
    @media (min-width: 640px) {
      body { padding: 48px 24px; }
      .card { border: 1px solid #e5e7eb; border-radius: 1rem; box-shadow: 0 20px 25px -5px rgb(0 0 0 / .1), 0 8px 10px -6px rgb(0 0 0 / .1); }
      .header { padding-left: 4rem; padding-right: 4rem; border-radius: 1rem 1rem 0 0; }
      .section, .footer { padding-left: 2.5rem; padding-right: 2.5rem; }
      .footer { border-radius: 0 0 1rem 1rem; }
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="header">
      <div class="logos">
        <div class="avatar" aria-hidden="true">${initial}</div>
        ${ARROW_LEFT_RIGHT_ICON}
        <img class="logo" src="${CODEQR_LOGO_DATA_URI}" alt="CodeQR">
      </div>
      <p class="request"><b>${name}</b> is requesting API access for a project on CodeQR.io.</p>
      <div class="badge">${WARNING_ICON}<span>CodeQR.io has not verified this application. Continue only if you started this connection yourself; if someone sent you this link, refuse.</span></div>
    </div>

    <div class="section">
      <span class="label">Access will be sent to:</span>
      <p class="target">${escapeHtml(destination.target)}</p>
      ${destination.note ? `<p class="note">${escapeHtml(destination.note)}</p>` : ''}
      <p class="uri">${escapeHtml(redirectUri)}</p>
    </div>

    <div class="section">
      <span class="label">Grant permissions:</span>
      <ul>
          ${scopeItems}
      </ul>
    </div>

    <div class="footer">
      <p class="hint">You will choose which project to grant access to on the next screen.</p>
      <form method="post" action="authorize">
        ${hiddenInputs}
        <div class="actions">
          <button type="submit" name="decision" value="deny" class="secondary">Refuse</button>
          <button type="submit" name="decision" value="approve" class="primary">Continue</button>
        </div>
      </form>
    </div>
  </main>
</body>
</html>
`;
}

/** A resource's write scope already includes its read, so only the write is listed. */
function consolidateScopes(scopes: readonly string[]): string[] {
  const consolidated = new Set<string>();

  for (const scope of scopes) {
    const [resource, action] = scope.split('.');
    if (action === 'write') {
      consolidated.delete(`${resource}.read`);
      consolidated.add(scope);
    } else if (!consolidated.has(`${resource}.write`)) {
      consolidated.add(scope);
    }
  }

  return Array.from(consolidated);
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
