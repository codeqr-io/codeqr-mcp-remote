import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CODEQR_APP_URL = 'https://app.example.test';
process.env.CODEQR_API_URL = 'https://api.example.test';
process.env.CODEQR_OAUTH_CLIENT_ID = 'codeqr_app_test';
process.env.CODEQR_OAUTH_CLIENT_SECRET = 'secret_test';
// Importing src/index.ts would otherwise start a listener.
process.env.VERCEL = '1';

const { TOOLS } = await import('../src/routes/mcp.js');
const { ITEM_CARD_URI, WIDGET_DESCRIPTION, WIDGET_MIME_TYPE, readWidget, withWidgetMeta } = await import('../src/widgets/index.js');
const { createAccessToken } = await import('../src/oauth/store.js');
const indexApp = (await import('../src/index.js')).default;

const CARD_TOOLS = ['create_link', 'create_qrcode', 'get_link_info', 'update_link', 'update_qrcode'];
// Apps in ChatGPT may not sell in the conversation (see plan-limit-message.test.ts).
const SELLING = /\b(plan|plans|price|pricing|upgrade|trial|subscri\w*|paid|billing|starter|business|enterprise)\b|\$\d/i;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('withWidgetMeta', () => {
  it('advertises the tools unchanged while MCP_UI_ENABLED is unset', () => {
    expect(withWidgetMeta(TOOLS)).toEqual(TOOLS);
  });

  it('points exactly the card tools at the item card template once switched on', () => {
    vi.stubEnv('MCP_UI_ENABLED', '1');

    const tools = withWidgetMeta(TOOLS);
    const withCard = tools.filter((tool) => tool._meta);

    expect(withCard.map((tool) => tool.name).sort()).toEqual(CARD_TOOLS);
    for (const tool of withCard) {
      expect(tool._meta).toMatchObject({ ui: { resourceUri: ITEM_CARD_URI }, 'openai/outputTemplate': ITEM_CARD_URI });
      for (const key of ['openai/toolInvocation/invoking', 'openai/toolInvocation/invoked']) {
        const status = tool._meta?.[key] as string;
        expect(status.length, `${tool.name} ${key}`).toBeLessThanOrEqual(64);
        expect(status).not.toMatch(SELLING);
      }
    }
    expect(TOOLS.some((tool) => '_meta' in tool && tool._meta)).toBe(false);
  });
});

describe('readWidget', () => {
  it('serves the item card as an MCP Apps page with a CSP limited to the image origins', () => {
    const widget = readWidget(ITEM_CARD_URI);
    const [content] = widget?.contents ?? [];

    expect(content).toMatchObject({ uri: ITEM_CARD_URI, mimeType: WIDGET_MIME_TYPE });
    expect(content.text).toContain('<div id="root"></div>');
    expect(content.text).not.toMatch(/<script[^>]*\bsrc=/i);
    expect(content._meta.ui).toEqual({
      csp: { connectDomains: [], resourceDomains: ['https://res.cloudinary.com', 'https://api.example.test'] },
      prefersBorder: true,
      permissions: { clipboardWrite: {} },
    });
    expect(content._meta['openai/widgetCSP']).toMatchObject({ redirect_domains: ['https://app.example.test'] });
    expect(content._meta['openai/widgetDescription']).not.toMatch(SELLING);
  });

  it('tells ChatGPT not to render the result again under the card', () => {
    const [content] = readWidget(ITEM_CARD_URI)?.contents ?? [];

    expect(content._meta['openai/widgetDescription']).toBe(WIDGET_DESCRIPTION);
    expect(WIDGET_DESCRIPTION).toMatch(/Do not show the QR image, the short link, the destination or the CodeQR link again/);
    expect(WIDGET_DESCRIPTION).toMatch(/do not build another card/);
  });

  it('leaves the host-specific ui.domain out', () => {
    const [content] = readWidget(ITEM_CARD_URI)?.contents ?? [];

    expect(content._meta.ui).not.toHaveProperty('domain');
    expect(content._meta['openai/widgetDomain']).toMatch(/^https:\/\//);
  });

  it('serves nothing else', () => {
    expect(readWidget('ui://codeqr/other.html')).toBeUndefined();
  });
});

describe('resources over /mcp', () => {
  let lines: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    lines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      for (const raw of String(chunk).split('\n')) {
        if (!raw.trim()) continue;
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.service === 'mcp') lines.push(parsed);
        } catch {
          // not a log line
        }
      }
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function rpc(body: unknown) {
    const { token } = await createAccessToken({
      clientId: 'client_widget_1',
      codeqr: { accessToken: 'cq_live_widget', refreshToken: 'cq_refresh_widget', expiresAt: Date.now() + 86_400_000 },
      scope: 'links',
    });
    const res = await request(indexApp)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .buffer(true)
      .parse((response, done) => {
        let text = '';
        response.on('data', (chunk: Buffer) => (text += chunk.toString()));
        response.on('end', () => done(null, text));
      })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(body as object) }));
    // The transport answers a POST as server-sent events: one `data:` line per message.
    const data = String(res.body)
      .split('\n')
      .find((line) => line.startsWith('data: '));
    return JSON.parse(data?.slice('data: '.length) ?? 'null');
  }

  it('declares resources in the handshake only while the card is switched on', async () => {
    const initialize = { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

    const off = await rpc(initialize);
    vi.stubEnv('MCP_UI_ENABLED', '1');
    const on = await rpc(initialize);

    expect(off.result.capabilities).not.toHaveProperty('resources');
    expect(on.result.capabilities).toHaveProperty('resources');
  });

  it('answers resources/read as an unknown method while the card is off', async () => {
    const answer = await rpc({ method: 'resources/read', params: { uri: ITEM_CARD_URI } });

    expect(answer.error?.code).toBe(-32601);
  });

  it('reads the item card template and logs the read without calling CodeQR', async () => {
    vi.stubEnv('MCP_UI_ENABLED', '1');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const answer = await rpc({ method: 'resources/read', params: { uri: ITEM_CARD_URI } });

    expect(answer.result.contents[0]).toMatchObject({ uri: ITEM_CARD_URI, mimeType: WIDGET_MIME_TYPE });
    expect(lines.find((line) => line.event === 'mcp.resource_read')).toMatchObject({
      resource: ITEM_CARD_URI,
      outcome: 'ok',
      clientId: 'client_widget_1',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('answers an unknown resource with an error and logs it', async () => {
    vi.stubEnv('MCP_UI_ENABLED', '1');
    const answer = await rpc({ method: 'resources/read', params: { uri: 'ui://codeqr/missing.html' } });

    expect(answer.error).toBeDefined();
    expect(lines.find((line) => line.event === 'mcp.resource_read')).toMatchObject({ outcome: 'error' });
  });

  it('lists the template, and no resource templates, while the card is switched on', async () => {
    vi.stubEnv('MCP_UI_ENABLED', '1');

    const listed = await rpc({ method: 'resources/list', params: {} });
    const templates = await rpc({ method: 'resources/templates/list', params: {} });

    expect(listed.result.resources.map((resource: { uri: string }) => resource.uri)).toEqual([ITEM_CARD_URI]);
    expect(templates.result.resourceTemplates).toEqual([]);
  });
});
