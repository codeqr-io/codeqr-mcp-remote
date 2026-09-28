/**
 * That `create_qrcode` and `update_qrcode` forward `title` and `walletPass`
 * to the SDK untouched.
 *
 * `tool-params.test.ts` proves `walletPass` is declared despite the installed
 * SDK's argument type not knowing the field at all (see the intersection
 * types there) — it says nothing about whether a real call still carries the
 * value. `asParams` is a cast, not a transform, so this is the only place
 * that would notice the handler silently dropping or renaming either field.
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
      return Promise.resolve({ id: 'qr_1' });
    };
  return {
    calls,
    client: {
      qrcodes: { create: record('qrcodes.create'), update: record('qrcodes.update') },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (client: unknown, name: string, args: Record<string, unknown>) =>
  handleToolCall(client as any, 'key', name, args);

const walletPass = {
  name: 'Central Bakery',
  logo: 'https://res.cloudinary.com/demo/image/upload/v1/qr-logos/a.png',
  barcodeText: 'Member #4471',
};

describe('create_qrcode', () => {
  it('forwards title and walletPass unchanged', async () => {
    const { client, calls } = spyClient();

    const res = await call(client, 'create_qrcode', {
      url: 'https://example.com',
      title: 'Central Bakery QR',
      walletPass,
    });

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('qrcodes.create');
    expect(calls[0].args[0]).toMatchObject({ title: 'Central Bakery QR', walletPass });
  });
});

describe('update_qrcode', () => {
  it('forwards title and walletPass unchanged, and keeps qrcodeId out of the body', async () => {
    const { client, calls } = spyClient();

    const res = await call(client, 'update_qrcode', {
      qrcodeId: 'qr_1',
      title: 'Central Bakery QR',
      walletPass,
    });

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('qrcodes.update');
    expect(calls[0].args[0]).toBe('qr_1');
    expect(calls[0].args[1]).toMatchObject({ title: 'Central Bakery QR', walletPass });
    expect(calls[0].args[1]).not.toHaveProperty('qrcodeId');
  });

  it('forwards walletPass: null unchanged, which is how an override is cleared', async () => {
    const { client, calls } = spyClient();

    const res = await call(client, 'update_qrcode', { qrcodeId: 'qr_1', walletPass: null });

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].args[1]).toMatchObject({ walletPass: null });
  });
});
