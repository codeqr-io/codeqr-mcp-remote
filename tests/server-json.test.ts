/**
 * Guards on `server.json`, the metadata the official MCP Registry publishes.
 *
 * The version now lives in three places — `package.json`, `SERVER_VERSION` in
 * src/config.ts, and `server.json` — and nothing but convention held them
 * together. That matters more here than it looks: the registry refuses to
 * republish a version it already has, so a bump that misses `server.json`
 * either fails at publish time or ships an entry whose version contradicts
 * what the server reports in its MCP handshake.
 *
 * Typecheck cannot catch it: two of the three are JSON. This file is the trap.
 *
 * The name and transport assertions pin the other half of the contract. The
 * registry grants the `io.codeqr` namespace only because a TXT record on the
 * apex of codeqr.io proves ownership, so the namespace is not a free-form
 * label — changing it silently breaks the ability to publish at all.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SERVER_VERSION } from '../src/config.js';

const serverJson = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The domain whose DNS TXT record authorizes publishing under `io.codeqr`. */
const VERIFIED_DOMAIN = 'codeqr.io';

describe('server.json', () => {
  it('carries the same version as package.json and SERVER_VERSION', () => {
    expect(serverJson.version).toBe(packageJson.version);
    expect(serverJson.version).toBe(SERVER_VERSION);
  });

  it('is named under the namespace the verified domain grants', () => {
    // Reverse-DNS of codeqr.io. `com.codeqr` would require owning codeqr.com,
    // which is a third party's.
    expect(serverJson.name).toMatch(/^io\.codeqr\//);
  });

  it('points at a streamable-http endpoint on the verified domain', () => {
    const remotes = serverJson.remotes ?? [];
    expect(remotes.length).toBeGreaterThan(0);

    for (const remote of remotes) {
      expect(remote.type).toBe('streamable-http');
      const { protocol, hostname } = new URL(remote.url);
      expect(protocol).toBe('https:');
      // Same registrable domain as the namespace, so a reader can tell the
      // endpoint belongs to whoever proved ownership.
      expect(hostname === VERIFIED_DOMAIN || hostname.endsWith(`.${VERIFIED_DOMAIN}`)).toBe(true);
    }
  });

  it('declares the schema it was validated against', () => {
    expect(serverJson.$schema).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/.+\/server\.schema\.json$/,
    );
  });
});
