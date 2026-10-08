import { describe, expect, it } from 'vitest';

import {
  MCP_CLIENT_LABELS,
  UNKNOWN_MCP_CLIENT,
  mcpClientLabel,
} from '../src/oauth/mcp-client-label.js';
import { VERIFIED_CLIENTS } from '../src/oauth/verified-clients.js';

// CodeQR drops an `mcp_client` outside this shape (the signup-attribution
// reader in the app), so a label that fails it would record nothing.
const CODEQR_MCP_CLIENT = /^[a-z0-9-]{1,32}$/;

describe('mcpClientLabel', () => {
  it.each([
    ['https://chatgpt.com/connector/oauth/fcLW7Kbi1AnJ', 'chatgpt'],
    ['https://chatgpt.com/connector/oauth/someoneElse', 'chatgpt'],
    ['https://chatgpt.com/connector_platform_oauth_redirect', 'chatgpt'],
    ['https://claude.ai/api/mcp/auth_callback', 'claude'],
    ['https://claude.com/api/mcp/auth_callback', 'claude'],
    ['https://vscode.dev/redirect', 'vscode'],
    ['vscode://vscode.github-authentication/did-authenticate', 'vscode'],
    ['cursor://anysphere.cursor-retrieval/oauth/user-codeqr/callback', 'cursor'],
    ['http://localhost:6274/oauth/callback', 'local'],
    ['http://127.0.0.1:33418/', 'local'],
    ['http://[::1]:8080/callback', 'local'],
  ])('labels %s as %s', (redirectUri, label) => {
    expect(mcpClientLabel(redirectUri)).toBe(label);
  });

  it.each([
    'https://attacker.test/callback',
    'https://chatgpt.com.attacker.test/callback',
    'https://claude.ai.attacker.test/callback',
    'not a url',
  ])('labels %s as other, never by its own host', (redirectUri) => {
    expect(mcpClientLabel(redirectUri)).toBe(UNKNOWN_MCP_CLIENT);
  });

  it('only ever returns labels CodeQR will record', () => {
    const labels = [...MCP_CLIENT_LABELS, ...Object.values(VERIFIED_CLIENTS).map((c) => c.id)];

    expect(labels.length).toBeGreaterThan(Object.keys(VERIFIED_CLIENTS).length);
    for (const label of labels) expect(label).toMatch(CODEQR_MCP_CLIENT);
  });
});
