/**
 * That the handler *calls* the validator.
 *
 * `smart-rules.test.ts` proves the rules are read correctly; it would keep
 * passing if nothing in `mcp.ts` ever called it. What has to hold is the
 * ordering: an invalid `rules` payload is rejected here, so it never becomes a
 * request — and a valid one is forwarded untouched, `split` included, because
 * the SDK type does not know that field and only the passthrough carries it.
 */

import { describe, it, expect } from 'vitest';
import { handleToolCall } from '../src/routes/mcp.js';

type Call = { method: string; args: unknown[] };

/** Records what the SDK would have been asked to do, and never calls out. */
function spyClient() {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve({ id: 'link_1' });
    };
  return {
    calls,
    client: {
      links: { create: record('links.create'), update: record('links.update') },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (client: unknown, name: string, args: Record<string, unknown>) =>
  handleToolCall(client as any, 'key', name, args);

const goodSplit = [
  { url: 'https://example.com/a', weight: 50 },
  { url: 'https://example.com/b', weight: 50 },
];

describe('create_link', () => {
  it('rejects invalid rules without calling the API', async () => {
    const { client, calls } = spyClient();

    const res = await call(client, 'create_link', {
      url: 'https://example.com',
      rules: [{ split: [{ url: 'https://example.com/a', weight: 60 }, { url: 'https://example.com/b', weight: 60 }] }],
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/add up to 100, got 120/);
    expect(calls, 'the API must not be called for a payload we already know is invalid').toEqual([]);
  });

  it('forwards valid rules, with split intact', async () => {
    const { client, calls } = spyClient();

    const res = await call(client, 'create_link', {
      url: 'https://example.com',
      rules: [{ split: goodSplit }],
    });

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('links.create');
    // The whole point: `split` survives the cast to LinkCreateParams, whose
    // Rule type has no such field.
    expect(calls[0].args[0]).toMatchObject({ rules: [{ split: goodSplit }] });
  });

  it('leaves a call without rules alone', async () => {
    const { client, calls } = spyClient();

    const res = await call(client, 'create_link', { url: 'https://example.com' });

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe('update_link', () => {
  it('rejects invalid rules without calling the API', async () => {
    const { client, calls } = spyClient();

    const res = await call(client, 'update_link', {
      linkId: 'link_1',
      rules: [{ url: 'https://example.com/x', split: goodSplit }],
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/never both/);
    expect(calls).toEqual([]);
  });

  it('forwards valid rules and keeps linkId out of the body', async () => {
    const { client, calls } = spyClient();

    await call(client, 'update_link', { linkId: 'link_1', rules: [{ split: goodSplit }] });

    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe('link_1');
    expect(calls[0].args[1]).toMatchObject({ rules: [{ split: goodSplit }] });
    expect(calls[0].args[1]).not.toHaveProperty('linkId');
  });
});
