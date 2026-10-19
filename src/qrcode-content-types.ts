// pix, geo and facetime are left out on purpose: read the note above
// QRCODE_PAYLOAD_PROPERTIES in routes/mcp.ts before adding one.
export const QRCODE_CONTENT_TYPES = [
  'url',
  'text',
  'email',
  'phone',
  'sms',
  'wifi',
  'vcard',
  'crypto',
  'whatsapp',
] as const;

export const DEFAULT_QRCODE_TYPE = 'url';

// The content these encode belongs to the person and does not move, so a code
// that holds it directly loses nothing. A url code stays dynamic: re-pointing
// and counting are why it is made here at all.
export const STATIC_QRCODE_TYPES = ['wifi', 'vcard', 'text'] as const satisfies ReadonlyArray<
  (typeof QRCODE_CONTENT_TYPES)[number]
>;

export const WIFI_SECURED_ENCRYPTIONS = ['WPA', 'WPA2', 'WEP'] as const;
export const WIFI_OPEN_NETWORK = 'nopass';
