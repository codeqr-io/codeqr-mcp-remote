import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/codeqr/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/codeqr/workspace.js')>();
  return { ...actual, getWorkspace: vi.fn() };
});

const { getWorkspace } = await import('../src/codeqr/workspace.js');
const { handleToolCall } = await import('../src/routes/mcp.js');
const { config } = await import('../src/config.js');
const { asCreatedResource, nextStepsText, qrImageUrl, shortLinkOf } = await import('../src/next-steps.js');

const mockGetWorkspace = vi.mocked(getWorkspace);

const created = { domain: 'freeqr.ink', key: 'abc123-qr' };
const APP = 'https://app.example.test';
const API = 'https://api.example.test';

// Apps in ChatGPT may not sell in the conversation; none of these may appear.
const SELLING = /\b(plan|plans|price|pricing|upgrade|trial|subscri\w*|paid|billing)\b/i;

describe('nextStepsText', () => {
  it('gives the short link, the QR image of that link and the dashboard page for a QR code', () => {
    const text = nextStepsText({ kind: 'qrcode', created, workspaceSlug: 'acme', appUrl: APP, apiUrl: API });
    const shortLink = shortLinkOf(created);

    expect(shortLink).toBe(`https://${created.domain}/${created.key}`);
    expect(text).toContain(shortLink);
    expect(text).toContain(qrImageUrl(API, shortLink));
    expect(qrImageUrl(API, shortLink)).toBe(`${API}/qr?url=${encodeURIComponent(shortLink)}`);
    expect(text).toContain(`${APP}/acme/qrcodes/${created.key}`);
  });

  it('points a link at the links section and offers no QR image', () => {
    const text = nextStepsText({ kind: 'link', created, workspaceSlug: 'acme', appUrl: APP, apiUrl: API });

    expect(text).toContain(`${APP}/acme/links/${created.key}`);
    expect(text).not.toContain(`${API}/qr`);
  });

  it('leaves the dashboard line out when the workspace slug is unknown', () => {
    const text = nextStepsText({ kind: 'qrcode', created, appUrl: APP, apiUrl: API });

    expect(text).toContain(shortLinkOf(created));
    expect(text).not.toContain(APP);
  });

  it.each(['qrcode', 'link'] as const)('never talks about plans or prices (%s)', (kind) => {
    for (const workspaceSlug of ['acme', undefined]) {
      const text = nextStepsText({ kind, created, workspaceSlug, appUrl: APP, apiUrl: API });
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(SELLING);
    }
  });
});

describe('asCreatedResource', () => {
  it('reads domain and key from a create response', () => {
    expect(asCreatedResource({ id: 'x', ...created, url: 'https://example.com' })).toEqual(created);
  });

  it.each([null, undefined, 'x', {}, { domain: 'a.test' }, { key: 'k' }, { domain: '', key: 'k' }])(
    'returns null for %j',
    (value) => {
      expect(asCreatedResource(value)).toBeNull();
    },
  );
});

describe('handleToolCall create note', () => {
  afterEach(() => {
    mockGetWorkspace.mockReset();
  });

  const stub = (response: unknown) => ({
    qrcodes: { create: vi.fn().mockResolvedValue(response), list: vi.fn().mockResolvedValue([response]) },
    links: { create: vi.fn().mockResolvedValue(response) },
  });

  it('appends the note after the unchanged JSON for create_qrcode', async () => {
    const response = { id: 'qr_1', ...created, type: 'url', url: 'https://example.com' };
    mockGetWorkspace.mockResolvedValue({ id: 'p', slug: 'acme', name: 'Acme', plan: 'free' } as never);

    const result = await handleToolCall(stub(response) as never, 'key', 'create_qrcode', { url: 'https://example.com' });

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
    const response = { id: 'l_1', ...created };
    mockGetWorkspace.mockRejectedValue(new Error('CodeQR unreachable'));

    const result = await handleToolCall(stub(response) as never, 'key', 'create_link', { url: 'https://example.com' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toContain(shortLinkOf(created));
    expect(result.content[1].text).not.toContain(config.codeqrAppUrl);
  });

  it('adds nothing to other tools or to a response without domain and key', async () => {
    const listed = await handleToolCall(stub({ id: 'qr_1', ...created }) as never, 'key', 'list_qrcodes', {});
    const bare = await handleToolCall(stub({ id: 'qr_2' }) as never, 'key', 'create_qrcode', {});

    expect(listed.content).toHaveLength(1);
    expect(bare.content).toHaveLength(1);
    expect(mockGetWorkspace).not.toHaveBeenCalled();
  });
});
