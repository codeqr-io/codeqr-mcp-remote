import { describe, expect, it } from 'vitest';

import { VERIFIED_CLIENTS } from '../src/oauth/verified-clients.js';

// CodeQR drops an `mcp_client` outside this shape (the signup-attribution
// reader in the app), so an id that fails it would record nothing.
const CODEQR_MCP_CLIENT = /^[a-z0-9-]{1,32}$/;

describe('verified clients', () => {
  it('each sends an id CodeQR will record', () => {
    const ids = Object.values(VERIFIED_CLIENTS).map((client) => client.id);

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(CODEQR_MCP_CLIENT);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
