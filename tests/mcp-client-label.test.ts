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

  it.each([
    ['Claude Code (codeqr)', 'http://localhost:51234/callback'],
    ['Claude Code (codeqr)', 'http://127.0.0.1:9/callback'],
    ['Claude Code (codeqr)', 'http://[::1]:8080/callback'],
  ])('labels %s on %s as claude-code', (clientName, redirectUri) => {
    expect(mcpClientLabel(redirectUri, clientName)).toBe('claude-code');
  });

  it.each(['Claude Code', 'Claude Code ()', 'Codex', 'MCP Inspector', 'claude code (codeqr)', ''])(
    'keeps loopback as local for the name %j',
    (clientName) => {
      expect(mcpClientLabel('http://localhost:51234/callback', clientName)).toBe('local');
    },
  );

  it('keeps loopback as local when no name is given', () => {
    expect(mcpClientLabel('http://localhost:51234/callback')).toBe('local');
  });

  it('never lets the name label a redirect that is not loopback', () => {
    expect(mcpClientLabel('https://attacker.test/cb', 'Claude Code (codeqr)')).toBe(UNKNOWN_MCP_CLIENT);
    expect(mcpClientLabel('https://chatgpt.com/connector/oauth/someoneElse', 'Claude Code (codeqr)')).toBe('chatgpt');
  });

  it('lets a verified redirect win over the name', () => {
    expect(mcpClientLabel('https://claude.ai/api/mcp/auth_callback', 'Claude Code (codeqr)')).toBe('claude');
  });

  it('only ever returns labels CodeQR will record', () => {
    const labels = [...MCP_CLIENT_LABELS, ...Object.values(VERIFIED_CLIENTS).map((c) => c.id)];

    expect(MCP_CLIENT_LABELS).toContain('claude-code');
    expect(labels.length).toBeGreaterThan(Object.keys(VERIFIED_CLIENTS).length);
    for (const label of labels) expect(label).toMatch(CODEQR_MCP_CLIENT);
  });
});
