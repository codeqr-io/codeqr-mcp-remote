import { describe, expect, it } from 'vitest';
import {
  QRCODE_CONTENT_TYPES,
  STATIC_QRCODE_TYPES,
  WIFI_OPEN_NETWORK,
  WIFI_SECURED_ENCRYPTIONS,
} from '../src/qrcode-content-types.js';
import { asksForStatic, prepareStaticQrCode, STATIC_TYPES_IN_WORDS } from '../src/static-qrcode.js';
import { handleToolCall, TOOLS, type ToolOutcome } from '../src/routes/mcp.js';

const wifi = (fields: Record<string, unknown>) => ({ type: 'wifi', static: true, wifi: { ssid: 'Shop-Guest', ...fields } });

describe('prepareStaticQrCode', () => {
  it('leaves a dynamic call untouched', () => {
    const args = { url: 'https://codeqr.io' };
    expect(prepareStaticQrCode(args)).toEqual({ args });
    expect(prepareStaticQrCode({ ...args, static: false })).toEqual({ args: { ...args, static: false } });
  });

  it('accepts a static text code as sent', () => {
    const args = { type: 'text', static: true, text: 'Table 4' };
    expect(prepareStaticQrCode(args)).toEqual({ args });
  });

  it('accepts a static contact card with something to print', () => {
    for (const vcard of [{ name: 'Ana' }, { phone: '+5511999999999' }, { address: 'Rua A, 1', city: 'Lisboa' }]) {
      const args = { type: 'vcard', static: true, vcard };
      expect(prepareStaticQrCode(args)).toEqual({ args });
    }
  });

  it('refuses a static contact card with nothing it would encode', () => {
    for (const vcard of [undefined, {}, { name: '' }, { city: 'Lisboa', country: 'PT' }]) {
      const prepared = prepareStaticQrCode({ type: 'vcard', static: true, vcard });
      expect('error' in prepared && prepared.error).toMatch(/needs at least one of vcard\.name/);
    }
  });

  it.each(QRCODE_CONTENT_TYPES.filter((type) => !(STATIC_QRCODE_TYPES as readonly string[]).includes(type)))(
    'refuses a static %s code',
    (type) => {
      const prepared = prepareStaticQrCode({ type, static: true });
      expect(prepared).toHaveProperty('error');
      expect('error' in prepared && prepared.error).toContain(STATIC_TYPES_IN_WORDS);
    },
  );

  it('refuses a static code with no type, which is a url code', () => {
    expect(prepareStaticQrCode({ url: 'https://codeqr.io', static: true })).toHaveProperty('error');
  });

  it('reads the string the API also accepts as a request for static', () => {
    expect(asksForStatic({ static: 'true' })).toBe(true);
    expect(asksForStatic({ static: 'false' })).toBe(false);
    expect(prepareStaticQrCode({ type: 'url', static: 'true' })).toHaveProperty('error');
  });

  it.each(WIFI_SECURED_ENCRYPTIONS)('accepts a static Wi-Fi code on %s with a password', (encryption) => {
    const args = wifi({ encryption, password: 'welcome2026' });
    expect(prepareStaticQrCode(args)).toEqual({ args });
  });

  it('refuses a static Wi-Fi code without a known security type', () => {
    for (const encryption of [undefined, 'WPA3', 'nome']) {
      const prepared = prepareStaticQrCode(wifi({ encryption, password: 'welcome2026' }));
      expect('error' in prepared && prepared.error).toMatch(/needs wifi\.encryption/);
    }
  });

  it('refuses a static Wi-Fi code on a secured network without a password', () => {
    for (const password of [undefined, '']) {
      const prepared = prepareStaticQrCode(wifi({ encryption: 'WPA2', password }));
      expect('error' in prepared && prepared.error).toMatch(/needs wifi\.password/);
    }
  });

  it('sends an empty password for an open network, so nothing encodes "undefined"', () => {
    const prepared = prepareStaticQrCode(wifi({ encryption: WIFI_OPEN_NETWORK }));
    expect(prepared).toEqual({ args: wifi({ encryption: WIFI_OPEN_NETWORK, password: '' }) });
  });
});

describe('create_qrcode static schema', () => {
  const qr = TOOLS.find((tool) => tool.name === 'create_qrcode');
  const properties = (qr?.inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string; enum?: unknown }>;

  it('declares static as an optional boolean that names exactly the static types', () => {
    expect(properties.static?.type).toBe('boolean');
    expect(properties.static?.description).toContain(`only for type ${STATIC_TYPES_IN_WORDS}`);
    for (const type of STATIC_QRCODE_TYPES) expect(QRCODE_CONTENT_TYPES).toContain(type);
    expect(qr?.description).toContain(`A ${STATIC_TYPES_IN_WORDS} code can be made static`);
  });

  it('offers the Wi-Fi security types the static check accepts', () => {
    const wifiProps = (properties.wifi as unknown as { properties: { encryption: { enum: string[] } } }).properties;
    expect(wifiProps.encryption.enum).toEqual([...WIFI_SECURED_ENCRYPTIONS, WIFI_OPEN_NETWORK]);
  });
});

describe('create_qrcode static call site', () => {
  async function call(args: Record<string, unknown>) {
    const sent: unknown[] = [];
    const client = { qrcodes: { create: (params: unknown) => (sent.push(params), Promise.resolve({ id: 'qr_1' })) } };
    let outcome: ToolOutcome | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await handleToolCall(client as any, 'key', 'create_qrcode', args, (ended) => {
      outcome = ended;
    });
    return { sent, result, outcome };
  }

  it('refuses a static url code without calling the API', async () => {
    const { sent, result, outcome } = await call({ url: 'https://codeqr.io', static: true });
    expect(sent).toEqual([]);
    expect(result.isError).toBe(true);
    expect(outcome).toBe('invalid_arguments');
  });

  it('forwards a static Wi-Fi code with static set and the open-network password filled', async () => {
    const { sent, outcome } = await call(wifi({ encryption: WIFI_OPEN_NETWORK }));
    expect(outcome).toBe('ok');
    expect(sent).toEqual([wifi({ encryption: WIFI_OPEN_NETWORK, password: '' })]);
  });
});
