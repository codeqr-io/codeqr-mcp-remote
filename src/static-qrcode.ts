import {
  DEFAULT_QRCODE_TYPE,
  STATIC_QRCODE_TYPES,
  WIFI_OPEN_NETWORK,
  WIFI_SECURED_ENCRYPTIONS,
} from './qrcode-content-types.js';

export const STATIC_TYPES_IN_WORDS = `${STATIC_QRCODE_TYPES.slice(0, -1).join(', ')} or ${STATIC_QRCODE_TYPES.at(-1)}`;

// City, state, zipcode and country are encoded only together with address, so
// on their own they would print an empty card.
const VCARD_ENCODED_ALONE = ['name', 'surname', 'phone', 'email', 'website', 'address'];

/** The API also takes the strings, so a model sending "true" still makes a static code. */
export function asksForStatic(args: Record<string, unknown>): boolean {
  return args.static === true || args.static === 'true';
}

/**
 * A static code is printed with its content and can never be fixed, so what
 * the API would encode badly is refused here instead. The Wi-Fi encoder writes
 * `T:` and `P:` from whatever it is given, a missing value included, which
 * yields a code that joins no network.
 */
export function prepareStaticQrCode(
  args: Record<string, unknown>,
): { args: Record<string, unknown> } | { error: string } {
  if (!asksForStatic(args)) return { args };

  const type = args.type ?? DEFAULT_QRCODE_TYPE;
  if (!(STATIC_QRCODE_TYPES as readonly unknown[]).includes(type)) {
    return {
      error: `A static QR code can only be made for type ${STATIC_TYPES_IN_WORDS}. A ${String(type)} code is created dynamic so it can be changed and counted later: send it without static.`,
    };
  }
  if (type === 'vcard') {
    const vcard = (typeof args.vcard === 'object' && args.vcard !== null ? args.vcard : {}) as Record<string, unknown>;
    const hasContent = VCARD_ENCODED_ALONE.some((field) => typeof vcard[field] === 'string' && vcard[field]);
    if (!hasContent) {
      return {
        error: `A static contact card needs at least one of vcard.${VCARD_ENCODED_ALONE.join(', vcard.')}: it is printed as it is and cannot be filled in later. Ask the person for the details.`,
      };
    }
  }
  if (type !== 'wifi') return { args };

  const wifi = (typeof args.wifi === 'object' && args.wifi !== null ? args.wifi : {}) as Record<string, unknown>;
  const { encryption, password } = wifi;
  if (encryption === WIFI_OPEN_NETWORK) {
    return { args: { ...args, wifi: { ...wifi, password: typeof password === 'string' ? password : '' } } };
  }
  if (typeof encryption !== 'string' || !(WIFI_SECURED_ENCRYPTIONS as readonly string[]).includes(encryption)) {
    return {
      error: `A static Wi-Fi code needs wifi.encryption: one of ${WIFI_SECURED_ENCRYPTIONS.join(', ')}, or ${WIFI_OPEN_NETWORK} for an open network. Ask the person which one the network uses.`,
    };
  }
  if (typeof password !== 'string' || !password) {
    return { error: `A static Wi-Fi code on a ${encryption} network needs wifi.password. Ask the person for it.` };
  }
  return { args };
}
