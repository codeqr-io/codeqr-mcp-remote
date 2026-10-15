import { describe, expect, it } from 'vitest';
import { ANALYTICS_META_KEY, buildAnalyticsCard } from '../src/analytics-card.js';

const APP = 'https://app.example.test';
const urls = { slug: 'acme', appUrl: APP };
const card = (args: Record<string, unknown>, result: unknown) => buildAnalyticsCard(args, result, urls)?.structuredContent;

describe('buildAnalyticsCard', () => {
  it("counts a QR code's traffic as scans, whichever event was asked for", () => {
    const remapped = { clicks: 0, scans: 42, leads: 0, sales: 0, saleAmount: 0, views: 0 };

    expect(card({ event: 'scans', groupBy: 'count', qrcodeId: 'qr_1', interval: '7d' }, remapped)).toEqual({
      kind: 'analytics',
      query: { event: 'scans', groupBy: 'count', interval: '7d', qrcodeId: 'qr_1' },
      metric: 'scans',
      total: 42,
    });
    // The API moves a QR code's clicks to `scans`; a "clicks" card would read 0.
    expect(card({ event: 'clicks', groupBy: 'count', qrcodeId: 'qr_1' }, remapped)).toMatchObject({ metric: 'scans', total: 42 });
  });

  it("reads a QR code's scans from `clicks` in a breakdown, where the API leaves them", () => {
    expect(
      card({ event: 'scans', groupBy: 'countries', qrcodeId: 'qr_1', interval: '30d' }, [
        { country: 'BR', city: '*', clicks: 9 },
        { country: 'US', city: '*', clicks: 3 },
      ]),
    ).toMatchObject({
      metric: 'scans',
      total: 12,
      rows: [
        { label: 'BR', v: 9, country: 'BR' },
        { label: 'US', v: 3, country: 'US' },
      ],
    });
  });

  it("counts a link's clicks", () => {
    expect(card({ event: 'clicks', groupBy: 'count', linkId: 'link_1' }, { clicks: 7, scans: 0 })).toMatchObject({
      metric: 'clicks',
      total: 7,
    });
  });

  it('calls all traffic visits where the API cannot split it, never scans', () => {
    // Without a QR code id, "scans" runs the composite query: every click
    // event of the workspace, links and pages included, lands in `clicks`.
    expect(card({ event: 'scans', groupBy: 'count' }, { clicks: 500, leads: 0, sales: 0 })).toMatchObject({
      metric: 'visits',
      total: 500,
    });
    expect(card({ event: 'clicks', groupBy: 'devices' }, [{ device: 'Mobile', clicks: 30 }])).toMatchObject({
      metric: 'visits',
      total: 30,
    });
  });

  it('keeps the split the API makes for a workspace count, and totals it as visits', () => {
    const split = { clicks: 10, scans: 5, views: 1, leads: 2, sales: 0, saleAmount: 0 };

    expect(card({ event: 'composite', groupBy: 'count' }, split)).toMatchObject({
      query: { event: 'composite', groupBy: 'count', interval: '24h' },
      metric: 'visits',
      total: 16,
      totals: { clicks: 10, scans: 5, views: 1, leads: 2 },
    });
    // "clicks" over the workspace is the API's own split: link clicks only.
    expect(card({ event: 'clicks', groupBy: 'count' }, split)).toMatchObject({ metric: 'clicks', total: 10 });
  });

  it('turns a timeseries into a series and its sum', () => {
    expect(
      card({ event: 'scans', groupBy: 'timeseries', qrcodeId: 'qr_1', interval: '7d' }, [
        { start: '2026-10-08T00:00:00.000Z', clicks: 0, scans: 3 },
        { start: '2026-10-09T00:00:00.000Z', clicks: 0, scans: 0 },
        { start: '2026-10-10T00:00:00.000Z', clicks: 0, scans: 7 },
      ]),
    ).toMatchObject({
      metric: 'scans',
      total: 10,
      series: [
        { t: '2026-10-08T00:00:00.000Z', v: 3 },
        { t: '2026-10-09T00:00:00.000Z', v: 0 },
        { t: '2026-10-10T00:00:00.000Z', v: 7 },
      ],
    });
  });

  it('counts leads and sales as such', () => {
    expect(card({ event: 'leads', groupBy: 'count' }, { clicks: 90, leads: 4 })).toMatchObject({ metric: 'leads', total: 4 });
  });

  it('keeps the top five rows, largest first, and counts the rest', () => {
    const devices = ['Desktop', 'Mobile', 'Tablet', 'Console', 'Smarttv', 'Wearable', 'Embedded'].map((device, i) => ({
      device,
      clicks: i + 1,
    }));

    const result = card({ event: 'clicks', groupBy: 'devices' }, devices);

    expect(result?.rows?.map((row) => row.label)).toEqual(['Embedded', 'Wearable', 'Smarttv', 'Console', 'Tablet']);
    expect(result?.more).toBe(2);
    expect(result?.total).toBe(28);
  });

  it('labels top codes and links by their short link, without a total the API only returns part of', () => {
    const qrcodes = card({ event: 'scans', groupBy: 'top_qrcodes' }, [
      { id: 'qr_1', domain: 'freeqr.ink', key: 'menu-qr', shortLink: 'https://freeqr.ink/menu-qr', scans: 8 },
    ]);
    const links = card({ event: 'clicks', groupBy: 'top_links' }, [{ shortLink: 'https://cqr.ink/launch', clicks: 5 }]);
    const cities = card({ event: 'clicks', groupBy: 'cities' }, [{ city: 'São Paulo', country: 'BR', clicks: 4 }]);

    expect(qrcodes).toMatchObject({ metric: 'scans', rows: [{ label: 'freeqr.ink/menu-qr', v: 8 }] });
    expect(qrcodes).not.toHaveProperty('total');
    expect(links).toMatchObject({ metric: 'clicks', rows: [{ label: 'cqr.ink/launch', v: 5 }] });
    expect(cities?.rows).toEqual([{ label: 'São Paulo', v: 4, country: 'BR' }]);
  });

  it('builds a card for an empty period, and none for a shape it does not know', () => {
    expect(card({ event: 'clicks', groupBy: 'countries' }, [])).toMatchObject({ total: 0, rows: [] });
    expect(card({ event: 'clicks', groupBy: 'count' }, 'nope')).toBeUndefined();
    expect(card({ groupBy: 'count' }, { clicks: 1 })).toBeUndefined();
  });

  it('opens the code itself, the domain or the workspace analytics, without guessing a type', () => {
    const link = (args: Record<string, unknown>, slug: string | undefined) =>
      buildAnalyticsCard({ event: 'scans', groupBy: 'count', interval: '7d', ...args }, { scans: 1 }, { slug, appUrl: APP })
        ?.meta[ANALYTICS_META_KEY].dashboardUrl;

    expect(link({ qrcodeId: 'qr_1' }, 'acme')).toBe(`${APP}/acme/qrcodes/edit?id=qr_1`);
    expect(link({ linkId: 'link_1' }, 'acme')).toBe(`${APP}/acme/links/edit?id=link_1`);
    // A key without a type is ignored by the API, so the numbers are the
    // domain's, and so is the page.
    expect(link({ domain: 'freeqr.ink', key: 'menu-qr' }, 'acme')).toBe(`${APP}/acme/analytics?domain=freeqr.ink&interval=7d`);
    expect(link({}, 'acme')).toBe(`${APP}/acme/analytics?interval=7d`);
    expect(link({}, undefined)).toBe(APP);
  });
});
