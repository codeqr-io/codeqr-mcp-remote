import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/codeqr/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/codeqr/workspace.js')>();
  return { ...actual, getWorkspace: vi.fn() };
});

const { getWorkspace } = await import('../src/codeqr/workspace.js');
const { handleToolCall, SLUG_LOOKUP_TIMEOUT_MS } = await import('../src/routes/mcp.js');
const { config } = await import('../src/config.js');
const { asCreatedResource, nextStepsText, qrImageUrl, shortLinkOf } = await import('../src/next-steps.js');

const mockGetWorkspace = vi.mocked(getWorkspace);

const created = { id: 'qr_123', domain: 'freeqr.ink', key: 'abc123-qr', isStatic: false };
const APP = 'https://app.example.test';
const API = 'https://api.example.test';

// Apps in ChatGPT may not sell in the conversation; none of these may appear.
const SELLING = /\b(plan|plans|price|pricing|upgrade|trial|subscri\w*|paid|billing)\b/i;

describe('nextStepsText', () => {
  it('gives the short link, the QR image of that link and the dashboard edit page for a QR code', () => {
    const text = nextStepsText({ kind: 'qrcode', created, workspaceSlug: 'acme', appUrl: APP, apiUrl: API });
    const shortLink = shortLinkOf(created);

    expect(shortLink).toBe(`https://${created.domain}/${created.key}`);
    expect(text).toContain(shortLink);
    expect(text).toContain(qrImageUrl(API, shortLink));
    expect(qrImageUrl(API, shortLink)).toBe(`${API}/qr?url=${encodeURIComponent(shortLink)}`);
    // Same route the dashboard itself navigates to after creating a code.
    expect(text).toContain(`${APP}/acme/qrcodes/edit?id=${created.id}`);
  });

  it('points a link at the links edit page and offers no QR image', () => {
    const text = nextStepsText({ kind: 'link', created, workspaceSlug: 'acme', appUrl: APP, apiUrl: API });

    expect(text).toContain(`${APP}/acme/links/edit?id=${created.id}`);
    expect(text).not.toContain(`${API}/qr`);
  });

  it('leaves the dashboard line out when the workspace slug is unknown', () => {
    const text = nextStepsText({ kind: 'qrcode', created, appUrl: APP, apiUrl: API });

    expect(text).toContain(shortLinkOf(created));
    expect(text).not.toContain(APP);
  });

  it('does not promise re-pointing or counting for a static code', () => {
    const dynamic = nextStepsText({ kind: 'qrcode', created, appUrl: APP, apiUrl: API });
    const fixed = nextStepsText({ kind: 'qrcode', created: { ...created, isStatic: true }, appUrl: APP, apiUrl: API });

    expect(dynamic).toMatch(/changed later/);
    expect(dynamic).toMatch(/counted/);
    expect(fixed).not.toMatch(/can be changed later without/);
    expect(fixed).not.toMatch(/is counted/);
    expect(fixed).toMatch(/static/);
  });

  // A static code is printed with its content; its short link is not what people scan.
  it('does not offer a static code\'s short link as live, but still gives its image', () => {
    const fixed = nextStepsText({ kind: 'qrcode', created: { ...created, isStatic: true }, appUrl: APP, apiUrl: API });

    expect(fixed).not.toMatch(/is live/);
    expect(fixed).toMatch(/^Your static QR code is ready\./);
    expect(fixed).toContain(`QR image: ${qrImageUrl(API, shortLinkOf(created))}`);
  });

  it.each(['qrcode', 'link'] as const)('never talks about plans or prices (%s)', (kind) => {
    for (const workspaceSlug of ['acme', undefined]) {
      for (const isStatic of [false, true]) {
        const text = nextStepsText({ kind, created: { ...created, isStatic }, workspaceSlug, appUrl: APP, apiUrl: API });
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(SELLING);
      }
    }
  });
});

describe('asCreatedResource', () => {
  it('reads id, domain, key and the static flag from a create response', () => {
    const { id, domain, key } = created;
    expect(asCreatedResource({ id, domain, key, url: 'https://acme.test', static: false })).toEqual(created);
    expect(asCreatedResource({ id, domain, key, static: true })).toEqual({ ...created, isStatic: true });
  });

  it.each([
    null,
    undefined,
    'x',
    {},
    { domain: 'a.test', key: 'k' },
    { id: 'i', key: 'k' },
    { id: 'i', domain: 'a.test' },
    { id: '', domain: 'a.test', key: 'k' },
  ])('returns null for %j', (value) => {
    expect(asCreatedResource(value)).toBeNull();
  });
});

describe('handleToolCall create note', () => {
  afterEach(() => {
    mockGetWorkspace.mockReset();
  });

  const stub = (response: unknown) => ({
    qrcodes: { create: vi.fn().mockResolvedValue(response), list: vi.fn().mockResolvedValue([response]) },
    links: { create: vi.fn().mockResolvedValue(response) },
  });

  const response = { id: created.id, domain: created.domain, key: created.key, type: 'url', static: false };

  it('appends the note after the unchanged JSON for create_qrcode', async () => {
    mockGetWorkspace.mockResolvedValue({ id: 'p', slug: 'acme', name: 'Acme', plan: 'free' } as never);

    const result = await handleToolCall(stub(response) as never, 'key', 'create_qrcode', { url: 'https://acme.test' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toBe(JSON.stringify(response, null, 2));
    expect(result.content[1].text).toBe(
      nextStepsText({
        kind: 'qrcode',
        created,
        workspaceSlug: 'acme',
        appUrl: config.codeqrAppUrl,
        apiUrl: config.codeqrApiUrl,
      }),
    );
  });

  it('still succeeds, without the dashboard line, when the workspace cannot be read', async () => {
    mockGetWorkspace.mockRejectedValue(new Error('CodeQR unreachable'));

    const result = await handleToolCall(stub(response) as never, 'key', 'create_link', { url: 'https://acme.test' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toContain(shortLinkOf(created));
    expect(result.content[1].text).not.toContain(config.codeqrAppUrl);
  });

  it('does not wait for a slow workspace read beyond SLUG_LOOKUP_TIMEOUT_MS', async () => {
    mockGetWorkspace.mockImplementation(() => new Promise(() => {}));

    const startedAt = Date.now();
    const result = await handleToolCall(stub(response) as never, 'key', 'create_qrcode', {});
    const elapsed = Date.now() - startedAt;

    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).not.toContain(config.codeqrAppUrl);
    expect(elapsed).toBeGreaterThanOrEqual(SLUG_LOOKUP_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(SLUG_LOOKUP_TIMEOUT_MS * 2);
  });

  it('adds nothing to other tools or to a response without id, domain and key', async () => {
    const listed = await handleToolCall(stub(response) as never, 'key', 'list_qrcodes', {});
    const bare = await handleToolCall(stub({ id: 'qr_2' }) as never, 'key', 'create_qrcode', {});

    expect(listed.content).toHaveLength(1);
    expect(bare.content).toHaveLength(1);
    expect(mockGetWorkspace).not.toHaveBeenCalled();
  });
});

describe('handleToolCall item card', () => {
  const ITEM_CARD_META_KEY = 'io.codeqr/card';
  const qr = { id: created.id, domain: created.domain, key: created.key, type: 'url', url: 'https://acme.test', static: false, scans: 3 };
  const link = { id: 'link_1', domain: 'cqr.ink', key: 'launch', url: 'https://acme.test', clicks: 5 };
  const stub = () => ({
    qrcodes: {
      create: vi.fn().mockResolvedValue(qr),
      update: vi.fn().mockResolvedValue(qr),
      list: vi.fn().mockResolvedValue([qr]),
    },
    links: {
      create: vi.fn().mockResolvedValue(link),
      update: vi.fn().mockResolvedValue(link),
      retrieveInfo: vi.fn().mockResolvedValue(link),
    },
  });

  afterEach(() => {
    mockGetWorkspace.mockReset();
    vi.unstubAllEnvs();
  });

  it('returns exactly what it returned before while MCP_UI_ENABLED is unset', async () => {
    mockGetWorkspace.mockResolvedValue({ id: 'p', slug: 'acme', name: 'Acme', plan: 'free' } as never);

    const createdQr = await handleToolCall(stub() as never, 'key', 'create_qrcode', {});
    const info = await handleToolCall(stub() as never, 'key', 'get_link_info', { linkId: 'link_1' });

    expect(Object.keys(createdQr).sort()).toEqual(['content']);
    expect(Object.keys(info).sort()).toEqual(['content']);
    expect(mockGetWorkspace).toHaveBeenCalledTimes(1);
  });

  it('adds the card to create_qrcode with a single workspace lookup shared with the note', async () => {
    vi.stubEnv('MCP_UI_ENABLED', '1');
    mockGetWorkspace.mockResolvedValue({ id: 'p', slug: 'acme', name: 'Acme', plan: 'free' } as never);

    const result = await handleToolCall(stub() as never, 'key', 'create_qrcode', {});

    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toBe(JSON.stringify(qr, null, 2));
    expect(result.structuredContent).toMatchObject({ kind: 'qrcode', id: created.id, scans: 3 });
    expect(result._meta?.[ITEM_CARD_META_KEY]).toMatchObject({
      editUrl: `${config.codeqrAppUrl}/acme/qrcodes/edit?id=${created.id}&showDownload=true`,
    });
    expect(mockGetWorkspace).toHaveBeenCalledTimes(1);
  });

  it('adds the card, but no note, to the update and info tools', async () => {
    vi.stubEnv('MCP_UI_ENABLED', '1');
    mockGetWorkspace.mockResolvedValue({ id: 'p', slug: 'acme', name: 'Acme', plan: 'free' } as never);

    const calls = [
      ['update_qrcode', { qrcodeId: created.id }, 'qrcode'],
      ['update_link', { linkId: 'link_1' }, 'link'],
      ['get_link_info', { linkId: 'link_1' }, 'link'],
    ] as const;
    for (const [name, args, kind] of calls) {
      const result = await handleToolCall(stub() as never, 'key', name, args);
      expect(result.content, name).toHaveLength(1);
      expect(result.structuredContent, name).toMatchObject({ kind });
    }
    expect(mockGetWorkspace).toHaveBeenCalledTimes(calls.length);
  });

  it('adds nothing to list tools or to a response without id, domain and key', async () => {
    vi.stubEnv('MCP_UI_ENABLED', '1');
    const bare = { qrcodes: { update: vi.fn().mockResolvedValue({ id: 'qr_2' }) } };

    const listed = await handleToolCall(stub() as never, 'key', 'list_qrcodes', {});
    const updated = await handleToolCall(bare as never, 'key', 'update_qrcode', { qrcodeId: 'qr_2' });

    expect(listed.structuredContent).toBeUndefined();
    expect(updated.structuredContent).toBeUndefined();
    expect(mockGetWorkspace).not.toHaveBeenCalled();
  });

  it('still shows the card, opening the dashboard home, when the workspace cannot be read', async () => {
    vi.stubEnv('MCP_UI_ENABLED', '1');
    mockGetWorkspace.mockRejectedValue(new Error('CodeQR unreachable'));

    const result = await handleToolCall(stub() as never, 'key', 'get_link_info', { linkId: 'link_1' });

    expect(result._meta?.[ITEM_CARD_META_KEY]).toMatchObject({ editUrl: config.codeqrAppUrl });
  });
});

describe('handleToolCall analytics card', () => {
  const ANALYTICS_META_KEY = 'io.codeqr/analytics';
  const stub = () => ({ analytics: { retrieve: vi.fn().mockResolvedValue({ clicks: 0, scans: 12 }) } });
  const args = { event: 'scans', groupBy: 'count', qrcodeId: 'qr_1', interval: '7d' };

  afterEach(() => {
    mockGetWorkspace.mockReset();
    vi.unstubAllEnvs();
  });

  it('returns only the JSON while MCP_UI_ENABLED is unset', async () => {
    const result = await handleToolCall(stub() as never, 'key', 'get_analytics', args);

    expect(Object.keys(result)).toEqual(['content']);
    expect(mockGetWorkspace).not.toHaveBeenCalled();
  });

  it('adds the analytics card, with one workspace lookup for its dashboard link', async () => {
    vi.stubEnv('MCP_UI_ENABLED', '1');
    mockGetWorkspace.mockResolvedValue({ id: 'p', slug: 'acme', name: 'Acme', plan: 'free' } as never);

    const result = await handleToolCall(stub() as never, 'key', 'get_analytics', args);

    expect(result.content).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({ kind: 'analytics', metric: 'scans', total: 12, query: args });
    expect(result._meta?.[ANALYTICS_META_KEY]).toEqual({
      dashboardUrl: `${config.codeqrAppUrl}/acme/qrcodes/edit?id=qr_1`,
    });
    expect(mockGetWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe('handleToolCall get_analytics request', () => {
  const notFound = () => Promise.reject(Object.assign(new Error('Not found'), { status: 404 }));
  const stub = (found: { qrcode?: string } = {}) => ({
    analytics: { retrieve: vi.fn().mockResolvedValue({ clicks: 1130, scans: 203, views: 0 }) },
    qrcodes: { retrieve: vi.fn(() => (found.qrcode ? Promise.resolve({ id: found.qrcode }) : notFound())) },
    links: { retrieveInfo: vi.fn(notFound) },
  });

  afterEach(() => {
    mockGetWorkspace.mockReset();
    vi.unstubAllEnvs();
  });

  it('asks the API for QR code traffic when scans are asked over the workspace', async () => {
    const client = stub();

    const result = await handleToolCall(client as never, 'key', 'get_analytics', { event: 'scans', groupBy: 'count', interval: '7d' });

    expect(client.analytics.retrieve).toHaveBeenCalledWith({ event: 'clicks', groupBy: 'count', interval: '7d', types: 'qrcode' });
    expect(result.isError).toBeUndefined();
  });

  it('resolves a domain and key to their QR code, and the card names them', async () => {
    vi.stubEnv('MCP_UI_ENABLED', '1');
    mockGetWorkspace.mockResolvedValue({ id: 'p', slug: 'acme', name: 'Acme', plan: 'free' } as never);
    const client = stub({ qrcode: 'qr_9' });

    const result = await handleToolCall(client as never, 'key', 'get_analytics', {
      event: 'scans',
      groupBy: 'count',
      domain: 'freeqr.ink',
      key: 'menu-qr',
    });

    expect(client.analytics.retrieve).toHaveBeenCalledWith({ event: 'scans', groupBy: 'count', qrcodeId: 'qr_9' });
    expect(result.structuredContent).toMatchObject({
      metric: 'scans',
      query: { qrcodeId: 'qr_9', domain: 'freeqr.ink', key: 'menu-qr' },
    });
  });

  it('answers a code that does not exist without asking the API for the whole domain', async () => {
    const client = stub();

    const result = await handleToolCall(client as never, 'key', 'get_analytics', {
      event: 'scans',
      groupBy: 'count',
      domain: 'freeqr.ink',
      key: 'nope',
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: No link or QR code at freeqr.ink/nope in this workspace.' }],
      isError: true,
    });
    expect(client.analytics.retrieve).not.toHaveBeenCalled();
  });
});
