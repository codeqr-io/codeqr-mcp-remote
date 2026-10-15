import { describe, expect, it } from 'vitest';
import { ANALYTICS_META_KEY, buildAnalyticsCard } from '../src/analytics-card.js';

const APP = 'https://app.example.test';
const urls = { slug: 'acme', appUrl: APP };

describe('buildAnalyticsCard', () => {
  it('turns a count into a total, keeping the query the card re-runs', () => {
    const card = buildAnalyticsCard(
      { event: 'scans', groupBy: 'count', qrcodeId: 'qr_1', interval: '7d' },
      { clicks: 0, scans: 42, leads: 0, sales: 0, saleAmount: 0, views: 0 },
      urls,
    );

    expect(card?.structuredContent).toEqual({
      kind: 'analytics',
      query: { event: 'scans', groupBy: 'count', interval: '7d', qrcodeId: 'qr_1' },
      metric: 'scans',
      total: 42,
    });
  });

  it('defaults the interval to the API default and lists every non-zero event of a composite count', () => {
    const card = buildAnalyticsCard(
      { event: 'composite', groupBy: 'count' },
      { clicks: 10, scans: 5, leads: 2, sales: 0, saleAmount: 0, views: 0 },
      urls,
    );

    expect(card?.structuredContent).toMatchObject({
      query: { event: 'composite', groupBy: 'count', interval: '24h' },
      metric: 'clicks',
      total: 10,
      totals: { clicks: 10, scans: 5, leads: 2 },
    });
  });

  it('turns a timeseries into a series and its sum', () => {
    const card = buildAnalyticsCard(
      { event: 'scans', groupBy: 'timeseries', qrcodeId: 'qr_1', interval: '7d' },
      [
        { start: '2026-10-08T00:00:00.000Z', clicks: 0, scans: 3 },
        { start: '2026-10-09T00:00:00.000Z', clicks: 0, scans: 0 },
        { start: '2026-10-10T00:00:00.000Z', clicks: 0, scans: 7 },
      ],
      urls,
    );

    expect(card?.structuredContent).toMatchObject({
      metric: 'scans',
      total: 10,
      series: [
        { t: '2026-10-08T00:00:00.000Z', v: 3 },
        { t: '2026-10-09T00:00:00.000Z', v: 0 },
        { t: '2026-10-10T00:00:00.000Z', v: 7 },
      ],
    });
  });

  it("reads a QR code's scans from `clicks` in a breakdown, where the API leaves them", () => {
    const card = buildAnalyticsCard(
      { event: 'scans', groupBy: 'countries', qrcodeId: 'qr_1', interval: '30d' },
      [
        { country: 'BR', city: '*', clicks: 9 },
        { country: 'US', city: '*', clicks: 3 },
      ],
      urls,
    );

    expect(card?.structuredContent).toMatchObject({
      total: 12,
      rows: [
        { label: 'BR', v: 9, country: 'BR' },
        { label: 'US', v: 3, country: 'US' },
      ],
    });
  });

  it('keeps the top five rows, largest first, and counts the rest', () => {
    const devices = ['Desktop', 'Mobile', 'Tablet', 'Console', 'Smarttv', 'Wearable', 'Embedded'].map((device, i) => ({
      device,
      clicks: i + 1,
    }));

    const card = buildAnalyticsCard({ event: 'clicks', groupBy: 'devices' }, devices, urls);

    expect(card?.structuredContent.rows?.map((row) => row.label)).toEqual([
      'Embedded',
      'Wearable',
      'Smarttv',
      'Console',
      'Tablet',
    ]);
    expect(card?.structuredContent.more).toBe(2);
    expect(card?.structuredContent.total).toBe(28);
  });

  it('labels top codes and links by their short link, and cities with their country', () => {
    const qrcodes = buildAnalyticsCard(
      { event: 'scans', groupBy: 'top_qrcodes' },
      [{ id: 'qr_1', domain: 'freeqr.ink', key: 'menu-qr', shortLink: 'https://freeqr.ink/menu-qr', scans: 8 }],
      urls,
    );
    const cities = buildAnalyticsCard(
      { event: 'clicks', groupBy: 'cities' },
      [{ city: 'São Paulo', country: 'BR', clicks: 4 }],
      urls,
    );

    expect(qrcodes?.structuredContent.rows).toEqual([{ label: 'freeqr.ink/menu-qr', v: 8 }]);
    expect(cities?.structuredContent.rows).toEqual([{ label: 'São Paulo', v: 4, country: 'BR' }]);
  });

  it('builds a card for an empty period, and none for a shape it does not know', () => {
    const empty = buildAnalyticsCard({ event: 'clicks', groupBy: 'countries' }, [], urls);

    expect(empty?.structuredContent).toMatchObject({ total: 0, rows: [] });
    expect(buildAnalyticsCard({ event: 'clicks', groupBy: 'count' }, 'nope', urls)).toBeUndefined();
    expect(buildAnalyticsCard({ groupBy: 'count' }, { clicks: 1 }, urls)).toBeUndefined();
  });

  it('opens the analytics of the filtered code, the code itself, or the workspace', () => {
    const link = (args: Record<string, unknown>, slug: string | undefined) =>
      buildAnalyticsCard({ event: 'scans', groupBy: 'count', interval: '7d', ...args }, { scans: 1 }, { slug, appUrl: APP })
        ?.meta[ANALYTICS_META_KEY].dashboardUrl;

    expect(link({ domain: 'freeqr.ink', key: 'menu-qr' }, 'acme')).toBe(
      `${APP}/acme/analytics?domain=freeqr.ink&key=menu-qr&type=qrcode&event=scans&interval=7d`,
    );
    expect(link({ qrcodeId: 'qr_1' }, 'acme')).toBe(`${APP}/acme/qrcodes/edit?id=qr_1`);
    expect(link({ linkId: 'link_1' }, 'acme')).toBe(`${APP}/acme/links/edit?id=link_1`);
    expect(link({}, 'acme')).toBe(`${APP}/acme/analytics?event=scans&interval=7d`);
    expect(link({}, undefined)).toBe(APP);
  });
});
