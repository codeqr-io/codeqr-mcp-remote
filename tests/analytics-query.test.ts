import { describe, expect, it, vi } from 'vitest';
import { resolveAnalyticsQuery } from '../src/analytics-query.js';

const notFound = () => Promise.reject(Object.assign(new Error('Not found'), { status: 404 }));
const client = (found: { qrcode?: string; link?: string } = {}) => ({
  qrcodes: { retrieve: vi.fn(() => (found.qrcode ? Promise.resolve({ id: found.qrcode }) : notFound())) },
  links: { retrieveInfo: vi.fn(() => (found.link ? Promise.resolve({ id: found.link }) : notFound())) },
});

describe('resolveAnalyticsQuery', () => {
  it('counts scans as QR code traffic, which the API only splits out with a type filter', async () => {
    const resolved = await resolveAnalyticsQuery(client() as never, { event: 'scans', groupBy: 'count', interval: '7d' });

    expect(resolved).toEqual({
      request: { event: 'clicks', groupBy: 'count', interval: '7d', types: 'qrcode' },
      cardArgs: { event: 'scans', groupBy: 'count', interval: '7d' },
    });
  });

  it('counts clicks as link clicks', async () => {
    const resolved = await resolveAnalyticsQuery(client() as never, { event: 'clicks', groupBy: 'countries' });

    expect(resolved).toMatchObject({ request: { event: 'clicks', groupBy: 'countries', types: 'link' } });
  });

  it('leaves composite, leads, sales, top lists and calls on a code id as they are', async () => {
    for (const args of [
      { event: 'clicks', groupBy: 'top_qrcodes' },
      { event: 'scans', groupBy: 'top_links' },
      { event: 'composite', groupBy: 'count' },
      { event: 'leads', groupBy: 'count' },
      { event: 'sales', groupBy: 'timeseries' },
      { event: 'scans', groupBy: 'countries', qrcodeId: 'qr_1' },
      { event: 'clicks', groupBy: 'devices', linkId: 'link_1' },
    ]) {
      expect(await resolveAnalyticsQuery(client() as never, args), JSON.stringify(args)).toEqual({ request: args, cardArgs: args });
    }
  });

  it('resolves a domain and key to the QR code they name, keeping them for the card', async () => {
    const api = client({ qrcode: 'qr_9' });

    const resolved = await resolveAnalyticsQuery(api as never, {
      event: 'scans',
      groupBy: 'count',
      domain: 'freeqr.ink',
      key: 'menu-qr',
    });

    expect(resolved).toEqual({
      request: { event: 'scans', groupBy: 'count', qrcodeId: 'qr_9' },
      cardArgs: { event: 'scans', groupBy: 'count', qrcodeId: 'qr_9', domain: 'freeqr.ink', key: 'menu-qr' },
    });
    expect(api.qrcodes.retrieve).toHaveBeenCalledWith({ domain: 'freeqr.ink', key: 'menu-qr' });
  });

  it('resolves a domain and key to the link they name', async () => {
    const resolved = await resolveAnalyticsQuery(client({ link: 'link_9' }) as never, {
      event: 'clicks',
      groupBy: 'timeseries',
      domain: 'cqr.ink',
      key: 'launch',
    });

    expect(resolved).toMatchObject({
      request: { event: 'clicks', groupBy: 'timeseries', linkId: 'link_9' },
      cardArgs: { linkId: 'link_9', domain: 'cqr.ink', key: 'launch' },
    });
  });

  it('says so when no code has that domain and key, instead of answering for the whole domain', async () => {
    const resolved = await resolveAnalyticsQuery(client() as never, {
      event: 'scans',
      groupBy: 'count',
      domain: 'freeqr.ink',
      key: 'nope',
    });

    expect(resolved).toEqual({ error: 'No link or QR code at freeqr.ink/nope in this workspace.' });
  });

  it('passes on a lookup that failed for another reason than not found', async () => {
    const api = client();
    api.qrcodes.retrieve.mockImplementation(() => Promise.reject(Object.assign(new Error('Rate limited'), { status: 429 })));

    await expect(
      resolveAnalyticsQuery(api as never, { event: 'scans', groupBy: 'count', domain: 'freeqr.ink', key: 'menu-qr' }),
    ).rejects.toThrow('Rate limited');
  });

  it("treats a domain's root as the domain itself, without a lookup", async () => {
    const api = client();

    const resolved = await resolveAnalyticsQuery(api as never, { event: 'clicks', groupBy: 'count', domain: 'cqr.ink', key: '_root' });

    expect(resolved).toMatchObject({ request: { domain: 'cqr.ink', key: '_root', types: 'link' } });
    expect(api.qrcodes.retrieve).not.toHaveBeenCalled();
    expect(api.links.retrieveInfo).not.toHaveBeenCalled();
  });
});
