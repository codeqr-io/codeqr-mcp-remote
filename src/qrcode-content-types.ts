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
