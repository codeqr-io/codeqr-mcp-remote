/**
 * The page that ends the OAuth flow on mobile, in place of a 302 to the client.
 *
 * On Android the redirect chain ends in the browser and the client app never
 * reopens; a link the user taps is what lets the OS hand the URL to the app.
 * It carries no script and no meta refresh for that reason: the tap is the point.
 */

import type { Response } from 'express';
import { CODEQR_LOGO_DATA_URI } from './codeqr-logo.js';
import { translate, type Locale, type MessageKey } from './i18n/index.js';
import { findVerifiedClient } from './verified-clients.js';

export interface HandoffPageParams {
  /** The exact URL the desktop flow redirects to, code or error included. */
  url: string;
  /** The client's registered redirect_uri, used to find a verified name and logo. */
  redirectUri: string;
  kind: 'success' | 'error';
  locale: Locale;
}

export function sendHandoffPage(res: Response, params: HandoffPageParams): void {
  res
    .status(200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      // No form-action or navigate-to: the link leaves for the client's redirect_uri.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    })
    .send(renderHandoffPage(params));
}

export function renderHandoffPage({ url, redirectUri, kind, locale }: HandoffPageParams): string {
  const verified = findVerifiedClient(redirectUri);
  const t = (key: MessageKey, values: Record<string, string> = {}) =>
    translate(
      locale,
      key,
      Object.fromEntries(Object.entries(values).map(([name, value]) => [name, escapeHtml(value)])),
    );

  // A self-declared name stays off the page: repeating it here would vouch for it.
  const message = verified
    ? t(kind === 'success' ? 'handoff.successVerified' : 'handoff.errorVerified', { client: verified.name })
    : t(kind === 'success' ? 'handoff.successGeneric' : 'handoff.errorGeneric');

  const clientMark = verified?.logo
    ? `<img class="client-logo" src="${escapeHtml(verified.logo)}" alt="${escapeHtml(verified.name)}">`
    : '';

  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${t('handoff.pageTitle')}</title>
  <style>
    * { box-sizing: border-box; }
    html { font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.5; -webkit-font-smoothing: antialiased; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1rem; color: #000; background: #eff6ff; }
    .card { width: 100%; max-width: 28rem; padding: 2rem 1.5rem; border: 1px solid #e5e7eb; border-radius: 1rem; background: #fff; text-align: center; box-shadow: 0 20px 25px -5px rgb(0 0 0 / .1), 0 8px 10px -6px rgb(0 0 0 / .1); }
    .logos { display: flex; align-items: center; justify-content: center; gap: .75rem; margin-bottom: 1.25rem; }
    .logo, .client-logo { display: block; width: 48px; height: 48px; }
    .client-logo { border: 1px solid #e5e7eb; border-radius: 9999px; }
    .message { margin: 0 0 1.5rem; font-size: 1.125rem; font-weight: 600; overflow-wrap: anywhere; }
    .button { display: flex; align-items: center; justify-content: center; min-height: 3rem; padding: 0 1.5rem; border-radius: .5rem; background: #000; color: #fff; font-size: 1rem; font-weight: 600; text-decoration: none; }
    .button:active { background: #1f2937; }
  </style>
</head>
<body>
  <main class="card">
    <div class="logos">
      ${clientMark}
      <img class="logo" src="${CODEQR_LOGO_DATA_URI}" alt="CodeQR">
    </div>
    <p class="message">${message}</p>
    <a class="button" href="${escapeHtml(url)}" rel="noopener noreferrer">${t('handoff.button')}</a>
  </main>
</body>
</html>
`;
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
