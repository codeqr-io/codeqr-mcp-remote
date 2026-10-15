// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, PROTOCOL_VERSION, type BridgeWindow } from '../web/item-card/bridge.js';
import { LOCALES, resolveLocale, stringsFor } from '../web/item-card/i18n.js';
import { CARD_META_KEY, renderCard, toCardView, type CardActions } from '../web/item-card/render.js';

const IMAGE = 'https://res.cloudinary.com/codeqr/image/upload/v1/freeqr.ink/abc-qr.png';
const EDIT = 'https://app.codeqr.io/acme/qrcodes/edit?id=qr_1&showDownload=true';

const qrResult = (overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  structuredContent: {
    kind: 'qrcode',
    id: 'qr_1',
    shortLink: 'https://freeqr.ink/abc-qr',
    title: 'Lunch menu',
    type: 'url',
    isStatic: false,
    archived: false,
    destination: 'https://example.com/menu',
    scans: 1234,
    ...overrides,
  },
  _meta: { [CARD_META_KEY]: { imageUrl: IMAGE, editUrl: EDIT, ...meta } },
});

function render(result: unknown, locale = 'en') {
  const root = document.createElement('div');
  const actions = {
    openLink: vi.fn(),
    sendMessage: vi.fn(),
    copy: vi.fn().mockResolvedValue(true),
  } satisfies CardActions;
  renderCard(root, toCardView(result as never), { strings: stringsFor(resolveLocale(locale)), locale }, actions);
  return { root, actions };
}

const buttons = (root: HTMLElement) => [...root.querySelectorAll('.actions button')] as HTMLButtonElement[];

describe('toCardView', () => {
  it('renders nothing for an error or a result without a card', () => {
    expect(toCardView({ isError: true, ...qrResult() })).toBeNull();
    expect(toCardView({ structuredContent: { kind: 'qrcode' } })).toBeNull();
    expect(toCardView({ structuredContent: { kind: 'note', shortLink: 'https://x.test/a' } })).toBeNull();
    expect(toCardView(undefined)).toBeNull();
  });

  it('drops an image from an unexpected origin, a non-https link and a bad count', () => {
    const view = toCardView(
      qrResult({ scans: -1 }, { imageUrl: 'https://tracker.example/pixel.png', editUrl: 'javascript:alert(1)' }) as never,
    );

    expect(view?.imageUrl).toBeUndefined();
    expect(view?.editUrl).toBeUndefined();
    expect(view?.count).toBeUndefined();
  });
});

describe('renderCard', () => {
  it('shows a dynamic QR code with its image, short link, destination, scans and both actions', () => {
    const { root, actions } = render(qrResult());

    const image = root.querySelector('img.qr');
    expect(image?.getAttribute('src')).toBe(IMAGE);
    expect(image?.getAttribute('alt')).toBe('QR code for freeqr.ink/abc-qr');
    expect(root.querySelector('.title')?.textContent).toBe('Lunch menu');
    expect(root.querySelector('.badge.dynamic')?.textContent).toBe('Dynamic · destination can change');
    expect(root.querySelector('.destination')?.textContent).toBe('example.com/menu');
    expect(root.querySelector('.short')?.textContent).toBe('freeqr.ink/abc-qr');
    expect(root.querySelector('.stat .value')?.textContent).toBe('1,234');

    const [open, ask] = buttons(root);
    open.click();
    ask.click();
    expect(actions.openLink).toHaveBeenCalledWith(EDIT);
    expect(actions.sendMessage).toHaveBeenCalledWith('How many scans has freeqr.ink/abc-qr had in the last 30 days?');
  });

  it('offers no scans question and no count for a static code', () => {
    const { scans: _scans, ...rest } = qrResult({ isStatic: true }).structuredContent;
    const { root } = render({ ...qrResult(), structuredContent: rest });

    expect(root.querySelector('.badge')?.textContent).toBe('Static');
    expect(root.querySelector('.stat')).toBeNull();
    expect(buttons(root).map((button) => button.textContent)).toEqual(['Open in CodeQR']);
  });

  it('keeps any text from the result as text', () => {
    const { root } = render(qrResult({ title: '<img src=x onerror="alert(1)">' }));

    expect(root.querySelector('.title')?.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(root.querySelectorAll('img')).toHaveLength(1);
  });

  it('shows a non-URL QR code by its type, and a card without image when none is given', () => {
    const { destination: _destination, ...wifi } = qrResult({ type: 'wifi' }).structuredContent;
    const { root } = render({ structuredContent: wifi, _meta: { [CARD_META_KEY]: { editUrl: EDIT } } });

    expect([...root.querySelectorAll('.badge')].map((badge) => badge.textContent)).toContain('Wi-Fi');
    expect(root.querySelector('.destination')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
  });

  it('describes a link with clicks', () => {
    const { root, actions } = render({
      structuredContent: { kind: 'link', id: 'l', shortLink: 'https://cqr.ink/launch', title: null, isStatic: false, archived: false, clicks: 7 },
    });

    expect(root.querySelector('.title')?.textContent).toBe('cqr.ink/launch');
    expect(root.querySelector('.stat .label')?.textContent).toBe('Clicks');
    buttons(root)[0].click();
    expect(actions.sendMessage).toHaveBeenCalledWith('How many clicks has cqr.ink/launch had in the last 30 days?');
  });

  it('speaks the host language', () => {
    const { root, actions } = render(qrResult(), 'pt-BR');

    expect(root.querySelector('.badge.dynamic')?.textContent).toBe('Dinâmico · o destino pode mudar');
    expect(root.querySelector('.stat .value')?.textContent).toBe('1.234');
    buttons(root)[1].click();
    expect(actions.sendMessage).toHaveBeenCalledWith('Quantos scans freeqr.ink/abc-qr teve nos últimos 30 dias?');
  });

  it('copies the full short link', async () => {
    const { root, actions } = render(qrResult());

    (root.querySelector('button.copy') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(actions.copy).toHaveBeenCalledWith('https://freeqr.ink/abc-qr');
  });
});

describe('resolveLocale', () => {
  it('maps host language tags onto the app locales', () => {
    expect(resolveLocale('pt-BR')).toBe('pt-br');
    expect(resolveLocale('pt')).toBe('pt-br');
    expect(resolveLocale('pt-PT')).toBe('pt-pt');
    expect(resolveLocale('es-MX')).toBe('es');
    expect(resolveLocale('zh-TW')).toBe('zh');
    expect(resolveLocale('nl')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });

  it('has every label in every locale', () => {
    const keys = (value: object): string[] => Object.keys(value).sort();
    const english = stringsFor('en');
    for (const locale of LOCALES) {
      const strings = stringsFor(locale);
      expect(keys(strings), locale).toEqual(keys(english));
      expect(keys(strings.types), locale).toEqual(keys(english.types));
      for (const value of [...Object.values(strings), ...Object.values(strings.types)]) {
        if (typeof value === 'string') expect(value.trim(), locale).not.toBe('');
      }
      expect(strings.askScans, locale).toContain('{link}');
      expect(strings.qrAlt, locale).toContain('{link}');
    }
  });
});

describe('connect', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeWindow(openai?: BridgeWindow['openai']) {
    const posted: Array<Record<string, unknown>> = [];
    const listeners: Record<string, Array<(event: { source: unknown; data: unknown }) => void>> = {};
    const parent = { postMessage: (message: unknown) => posted.push(message as Record<string, unknown>) };
    const win = {
      parent,
      openai,
      addEventListener: (type: string, listener: (event: { source: unknown; data: unknown }) => void) => {
        (listeners[type] ??= []).push(listener);
      },
    } as unknown as BridgeWindow;
    const fromHost = (data: unknown, source: unknown = parent) => listeners.message?.forEach((fn) => fn({ source, data }));
    return { win, posted, fromHost };
  }

  it('completes the MCP Apps handshake and hands over the host context and the tool result', async () => {
    const { win, posted, fromHost } = fakeWindow();
    const host = connect(win, { name: 'codeqr-item-card', version: '1' });
    const onResult = vi.fn();
    const onContext = vi.fn();
    host.onToolResult(onResult);
    host.onContext(onContext);

    expect(posted[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'ui/initialize',
      params: { protocolVersion: PROTOCOL_VERSION, appInfo: { name: 'codeqr-item-card' } },
    });
    fromHost({ jsonrpc: '2.0', id: posted[0].id, result: { hostContext: { theme: 'dark', locale: 'fr-FR' } } });
    await Promise.resolve();
    expect(posted[1]).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    expect(onContext).toHaveBeenLastCalledWith({ theme: 'dark', locale: 'fr-FR' });

    const result = qrResult();
    fromHost({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result });
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it('ignores messages that do not come from the host', () => {
    const { win, fromHost } = fakeWindow();
    const host = connect(win, { name: 'codeqr-item-card', version: '1' });
    const onResult = vi.fn();
    host.onToolResult(onResult);

    fromHost({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: qrResult() }, { not: 'the host' });
    fromHost({ method: 'ui/notifications/tool-result', params: qrResult() });

    expect(onResult).not.toHaveBeenCalled();
  });

  it('asks the host to open links and post messages, and answers its pings', async () => {
    const { win, posted, fromHost } = fakeWindow();
    const host = connect(win, { name: 'codeqr-item-card', version: '1' });

    const opened = host.openLink(EDIT);
    const request = posted.at(-1) as { id: number };
    expect(posted.at(-1)).toMatchObject({ method: 'ui/open-link', params: { url: EDIT } });
    fromHost({ jsonrpc: '2.0', id: request.id, result: {} });
    await expect(opened).resolves.toBeUndefined();

    void host.sendMessage('How many scans?');
    expect(posted.at(-1)).toMatchObject({
      method: 'ui/message',
      params: { role: 'user', content: [{ type: 'text', text: 'How many scans?' }] },
    });

    fromHost({ jsonrpc: '2.0', id: 99, method: 'ping' });
    expect(posted.at(-1)).toEqual({ jsonrpc: '2.0', id: 99, result: {} });
  });

  it("falls back to ChatGPT's window.openai when the handshake goes unanswered", async () => {
    vi.useFakeTimers();
    const openExternal = vi.fn();
    const result = qrResult();
    const { win } = fakeWindow({
      toolOutput: result.structuredContent,
      toolResponseMetadata: result._meta,
      theme: 'dark',
      locale: 'de-DE',
      openExternal,
    });
    const host = connect(win, { name: 'codeqr-item-card', version: '1' });
    const onResult = vi.fn();
    const onContext = vi.fn();
    host.onToolResult(onResult);
    host.onContext(onContext);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(onResult).toHaveBeenCalledWith({ structuredContent: result.structuredContent, _meta: result._meta });
    expect(onContext).toHaveBeenLastCalledWith({ theme: 'dark', locale: 'de-DE' });
    await host.openLink(EDIT);
    expect(openExternal).toHaveBeenCalledWith({ href: EDIT });
  });
});
