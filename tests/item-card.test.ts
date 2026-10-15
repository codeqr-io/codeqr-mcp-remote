import { describe, expect, it } from 'vitest';
import { ITEM_CARD_META_KEY, buildItemCard, isItemCardTool, itemCardKind } from '../src/item-card.js';
import { qrImageUrl } from '../src/next-steps.js';

const APP = 'https://app.example.test';
const API = 'https://api.example.test';
const urls = { appUrl: APP, apiUrl: API };

const CLOUDINARY_IMAGE = 'https://res.cloudinary.com/codeqr/image/upload/v1/freeqr.ink/abc-qr.png';

// A QR code row as the API returns it today: the whole database row, sensitive
// columns included.
const qrRow = {
  id: 'qr_1',
  domain: 'freeqr.ink',
  key: 'abc-qr',
  type: 'url',
  url: 'https://example.com/menu',
  static: false,
  title: 'Lunch menu',
  scans: 12,
  archived: false,
  image: CLOUDINARY_IMAGE,
  password: 'link-password-s3cret',
  wifi: { ssid: 'Home', password: 'wifi-password-s3cret' },
  vcard: { firstName: 'Ana', phone: '+5511999990000' },
  notificationToken: 'ExponentPushToken[device-token]',
  webhookIds: ['wh_secret_1'],
  userId: 'user_secret_1',
  projectId: 'prj_secret_1',
};

const linkRow = {
  id: 'link_1',
  domain: 'cqr.ink',
  key: 'launch',
  url: 'https://example.com/launch',
  shortLink: 'https://cqr.ink/launch',
  qrCode: `${API}/qr?url=https://cqr.ink/launch?qr=1`,
  title: null,
  clicks: 40,
  archived: false,
  password: 'link-password-s3cret',
  userId: 'user_secret_1',
  projectId: 'prj_secret_1',
};

const SENSITIVE = /s3cret|ExponentPushToken|wh_secret|user_secret|prj_secret|Ana|\+5511/;

describe('buildItemCard', () => {
  it('keeps only the allowlisted fields of a QR code, for the model and for the widget', () => {
    const card = buildItemCard('qrcode', qrRow, { slug: 'acme', ...urls });

    expect(card?.structuredContent).toEqual({
      kind: 'qrcode',
      id: 'qr_1',
      shortLink: 'https://freeqr.ink/abc-qr',
      title: 'Lunch menu',
      type: 'url',
      isStatic: false,
      archived: false,
      destination: 'https://example.com/menu',
      scans: 12,
    });
    expect(JSON.stringify(card)).not.toMatch(SENSITIVE);
  });

  it('puts the image and dashboard URLs only in the widget metadata', () => {
    const card = buildItemCard('qrcode', qrRow, { slug: 'acme', ...urls });

    expect(card?.meta).toEqual({
      [ITEM_CARD_META_KEY]: {
        imageUrl: CLOUDINARY_IMAGE,
        editUrl: `${APP}/acme/qrcodes/edit?id=qr_1&showDownload=true`,
      },
    });
    expect(JSON.stringify(card?.structuredContent)).not.toContain(APP);
  });

  it('never carries the encoded payload of a QR code that is not a URL', () => {
    const wifi = { ...qrRow, type: 'wifi', url: 'WIFI:S:Home;T:WPA;P:wifi-password-s3cret;;' };

    const card = buildItemCard('qrcode', wifi, { slug: 'acme', ...urls });

    expect(card?.structuredContent.type).toBe('wifi');
    expect(card?.structuredContent).not.toHaveProperty('destination');
    expect(JSON.stringify(card)).not.toMatch(SENSITIVE);
  });

  it('marks a static QR code as such', () => {
    const card = buildItemCard('qrcode', { ...qrRow, static: true }, { slug: 'acme', ...urls });

    expect(card?.structuredContent.isStatic).toBe(true);
  });

  it('falls back to the public QR generator when the stored image is not on Cloudinary', () => {
    const elsewhere = { ...qrRow, image: 'https://evil.example/tracker.png' };
    const missing = { ...qrRow, image: null };

    for (const row of [elsewhere, missing]) {
      const card = buildItemCard('qrcode', row, { slug: 'acme', ...urls });
      expect(card?.meta[ITEM_CARD_META_KEY].imageUrl).toBe(qrImageUrl(API, 'https://freeqr.ink/abc-qr'));
    }
  });

  it('describes a link with its clicks and the QR image the API already built for it', () => {
    const card = buildItemCard('link', linkRow, { slug: 'acme', ...urls });

    expect(card?.structuredContent).toEqual({
      kind: 'link',
      id: 'link_1',
      shortLink: 'https://cqr.ink/launch',
      title: null,
      isStatic: false,
      archived: false,
      destination: 'https://example.com/launch',
      clicks: 40,
    });
    expect(card?.meta[ITEM_CARD_META_KEY]).toEqual({
      imageUrl: linkRow.qrCode,
      editUrl: `${APP}/acme/links/edit?id=link_1`,
    });
    expect(JSON.stringify(card)).not.toMatch(SENSITIVE);
  });

  it('builds the QR image of a link itself when the API one points elsewhere', () => {
    const card = buildItemCard('link', { ...linkRow, qrCode: 'https://other.example/qr' }, { slug: 'acme', ...urls });

    expect(card?.meta[ITEM_CARD_META_KEY].imageUrl).toBe(qrImageUrl(API, 'https://cqr.ink/launch'));
  });

  it('opens the dashboard home when the workspace slug could not be read', () => {
    const card = buildItemCard('qrcode', qrRow, { slug: undefined, ...urls });

    expect(card?.meta[ITEM_CARD_META_KEY].editUrl).toBe(APP);
  });

  it('builds nothing from a response without id, domain and key', () => {
    expect(buildItemCard('qrcode', { id: 'qr_2' }, { slug: 'acme', ...urls })).toBeUndefined();
    expect(buildItemCard('link', null, { slug: 'acme', ...urls })).toBeUndefined();
  });
});

describe('item card tools', () => {
  it('covers the tools that return one QR code or link', () => {
    for (const name of ['create_qrcode', 'update_qrcode', 'create_link', 'update_link', 'get_link_info']) {
      expect(isItemCardTool(name), name).toBe(true);
    }
    for (const name of ['list_qrcodes', 'list_links', 'delete_qrcode', 'get_analytics', 'get_workspace']) {
      expect(isItemCardTool(name), name).toBe(false);
    }
    expect(itemCardKind('update_qrcode')).toBe('qrcode');
    expect(itemCardKind('get_link_info')).toBe('link');
  });
});
