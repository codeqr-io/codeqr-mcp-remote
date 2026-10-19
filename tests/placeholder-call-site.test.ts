/**
 * That the handler refuses a placeholder destination before the SDK is
 * called. `placeholder-destination.test.ts` proves the hosts are recognised;
 * it would keep passing if nothing in `mcp.ts` checked them.
 */

import { describe, it, expect } from 'vitest';
import { handleToolCall, SERVER_INSTRUCTIONS, type ToolOutcome } from '../src/routes/mcp.js';
import { PLACEHOLDER_HOSTS } from '../src/placeholder-destination.js';

type Call = { method: string; args: unknown[] };

function spyClient() {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve({ id: 'x' });
    };
  return {
    calls,
    client: {
      links: { create: record('links.create'), update: record('links.update') },
      qrcodes: { create: record('qrcodes.create'), update: record('qrcodes.update') },
    },
  };
}

async function call(name: string, args: Record<string, unknown>) {
  const { calls, client } = spyClient();
  let outcome: ToolOutcome | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await handleToolCall(client as any, 'key', name, args, (ended) => {
    outcome = ended;
  });
  return { calls, result, outcome };
}

const TOOL_ARGS: Array<[string, Record<string, unknown>]> = [
  ['create_link', {}],
  ['update_link', { linkId: 'link_1' }],
  ['create_qrcode', {}],
  ['update_qrcode', { qrcodeId: 'qr_1' }],
];

describe('a placeholder destination', () => {
  it.each(TOOL_ARGS)('is refused by %s without calling the API', async (tool, base) => {
    const { calls, result, outcome } = await call(tool, { ...base, url: 'https://example.com/menu' });

    expect(calls).toEqual([]);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Error: example\.com is a placeholder address/);
    expect(outcome).toBe('placeholder_destination');
  });

  it('is refused for every listed host, subdomains included', async () => {
    for (const host of PLACEHOLDER_HOSTS) {
      const { calls, outcome } = await call('create_qrcode', { url: `https://menu.${host}/` });
      expect(calls).toEqual([]);
      expect(outcome).toBe('placeholder_destination');
    }
  });

  // The instructions tell the model CodeQR refuses the placeholder they name;
  // this holds that sentence against the handler.
  it('named in the instructions is one the handler refuses', async () => {
    const named = /placeholder such as ([a-z0-9.-]+[a-z])/i.exec(SERVER_INSTRUCTIONS)?.[1];
    expect(named).toBeDefined();
    const { calls, outcome } = await call('create_link', { url: `https://${named}/` });
    expect(calls).toEqual([]);
    expect(outcome).toBe('placeholder_destination');
  });
});

describe('a real destination', () => {
  it.each(TOOL_ARGS)('reaches the API through %s', async (tool, base) => {
    const { calls, result, outcome } = await call(tool, { ...base, url: 'https://codeqr.io/menu' });

    expect(calls).toHaveLength(1);
    expect(result.isError).toBeUndefined();
    expect(outcome).toBe('ok');
  });

  it('is not needed by a Wi-Fi code', async () => {
    const { calls, outcome } = await call('create_qrcode', { type: 'wifi', wifi: { ssid: 'Cafe', encryption: 'WPA2' } });
    expect(calls).toHaveLength(1);
    expect(outcome).toBe('ok');
  });
});
