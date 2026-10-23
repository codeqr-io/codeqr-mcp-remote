import { describe, expect, it } from 'vitest';

import { CODEQR_OAUTH_SCOPES } from '../src/config.js';
import { renderConsentPage } from '../src/oauth/consent-page.js';
import { renderHandoffPage } from '../src/oauth/handoff-page.js';
import { mcpClientLabel } from '../src/oauth/mcp-client-label.js';
import { canRemember } from '../src/oauth/remembered-consent.js';
import { findVerifiedClient } from '../src/oauth/verified-clients.js';

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

describe('Claude apps as a verified client', () => {
  it('is verified by its exact callback, under its own name and attribution id', () => {
    expect(findVerifiedClient(CLAUDE_CALLBACK)).toEqual({ name: 'Claude', id: 'claude', platformCallback: true });
    expect(mcpClientLabel(CLAUDE_CALLBACK)).toBe('claude');
  });

  it('is never remembered, unlike the app-specific ChatGPT callback', () => {
    expect(canRemember(CLAUDE_CALLBACK)).toBe(false);
    expect(canRemember('https://chatgpt.com/connector/oauth/fcLW7Kbi1AnJ')).toBe(true);
  });

  it('shows the verified badge and an initial, never a logo, on the consent page', () => {
    const html = renderConsentPage({
      clientName: 'Whatever it registered as',
      redirectUri: CLAUDE_CALLBACK,
      scopes: CODEQR_OAUTH_SCOPES,
      locale: 'en',
      fields: {},
    });

    expect(html).toContain('<b>Claude</b>');
    expect(html).not.toContain('Whatever it registered as');
    expect(html).toContain('badge verified');
    expect(html).toContain('<div class="avatar" aria-hidden="true">C</div>');
    expect(html).not.toContain('<img class="client-logo"');
  });

  it.each(['success', 'error'] as const)('names Claude on the %s handoff page without a client image', (kind) => {
    const html = renderHandoffPage({ url: `${CLAUDE_CALLBACK}?code=x`, redirectUri: CLAUDE_CALLBACK, kind, locale: 'en' });

    expect(html).toContain('Claude');
    expect(html).not.toContain('<img class="client-logo"');
    expect(html).not.toContain('alt="Claude"');
  });

  it.each([
    'https://claude.com/api/mcp/auth_callback',
    `${CLAUDE_CALLBACK}/extra`,
    `${CLAUDE_CALLBACK}?x=1`,
    `${CLAUDE_CALLBACK}/`,
    'http://claude.ai/api/mcp/auth_callback',
  ])('does not verify %s', (redirectUri) => {
    expect(findVerifiedClient(redirectUri)).toBeUndefined();
    expect(canRemember(redirectUri)).toBe(false);
  });
});
