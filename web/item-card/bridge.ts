/**
 * The widget's side of the MCP Apps bridge: JSON-RPC 2.0 over postMessage with
 * the host (specification 2026-01-26). Written by hand rather than with
 * `@modelcontextprotocol/ext-apps`: the card needs six messages, and the
 * library brings the MCP SDK and zod into a page that ships inside every
 * tool result, around 300 KB.
 *
 * ChatGPT also exposes `window.openai`. It is used only when the standard
 * handshake gets no answer, so a host that speaks both renders once.
 */

export const PROTOCOL_VERSION = '2026-01-26';
const HANDSHAKE_TIMEOUT_MS = 2_000;

export interface HostContext {
  theme?: 'light' | 'dark';
  locale?: string;
  styles?: { variables?: Record<string, string | undefined> };
}

/** The tool result as the host forwards it: the whole CallToolResult. */
export interface ToolResult {
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}

export interface Host {
  onToolResult(handler: (result: ToolResult) => void): void;
  onContext(handler: (context: HostContext) => void): void;
  openLink(url: string): Promise<void>;
  sendMessage(text: string): Promise<void>;
  reportSize(width: number, height: number): void;
}

interface OpenAiGlobals {
  toolOutput?: unknown;
  toolResponseMetadata?: Record<string, unknown> | null;
  theme?: 'light' | 'dark';
  locale?: string;
  openExternal?: (options: { href: string }) => unknown;
  sendFollowUpMessage?: (options: { prompt: string }) => unknown;
}

/** The parts of `window` the bridge touches, so tests can pass a fake. */
export interface BridgeWindow {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: 'message', listener: (event: { source: unknown; data: unknown }) => void): void;
  addEventListener(type: 'openai:set_globals', listener: () => void): void;
  openai?: OpenAiGlobals;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export function connect(win: BridgeWindow, appInfo: { name: string; version: string }): Host {
  let resultHandler: (result: ToolResult) => void = () => {};
  let contextHandler: (context: HostContext) => void = () => {};
  let context: HostContext = {};
  let lastResult: ToolResult | undefined;
  let useOpenAi = false;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const post = (message: Record<string, unknown>) => win.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');

  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ id, method, params });
    });

  const emitResult = (result: ToolResult) => {
    lastResult = result;
    resultHandler(result);
  };

  const updateContext = (partial: HostContext) => {
    context = { ...context, ...partial };
    contextHandler(context);
  };

  win.addEventListener('message', (event) => {
    if (event.source !== win.parent) return;
    const message = event.data as Record<string, unknown> | null;
    if (!message || message.jsonrpc !== '2.0') return;

    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if ('error' in message) waiting.reject(new Error(String((message.error as { message?: unknown })?.message)));
      else waiting.resolve(message.result);
      return;
    }

    switch (message.method) {
      case 'ui/notifications/tool-result':
        emitResult((message.params ?? {}) as ToolResult);
        break;
      case 'ui/notifications/host-context-changed':
        updateContext((message.params ?? {}) as HostContext);
        break;
      case 'ping':
      case 'ui/resource-teardown':
        // Requests from the host: answered empty, the card holds no state to save.
        if (message.id !== undefined) post({ id: message.id, result: {} });
        break;
    }
  });

  const openAiResult = (): ToolResult | undefined => {
    const openai = win.openai;
    if (!openai || openai.toolOutput == null) return undefined;
    return { structuredContent: openai.toolOutput, _meta: openai.toolResponseMetadata ?? undefined };
  };

  const fallBackToOpenAi = () => {
    const openai = win.openai;
    if (!openai || useOpenAi) return;
    useOpenAi = true;
    updateContext({ theme: openai.theme, locale: openai.locale });
    const result = openAiResult();
    if (result) emitResult(result);
    win.addEventListener('openai:set_globals', () => {
      updateContext({ theme: win.openai?.theme, locale: win.openai?.locale });
      const next = openAiResult();
      if (next) emitResult(next);
    });
  };

  const handshake = request('ui/initialize', {
    protocolVersion: PROTOCOL_VERSION,
    appInfo,
    appCapabilities: { availableDisplayModes: ['inline'] },
  });
  let initialized = false;
  handshake.then(
    (answer) => {
      if (useOpenAi) return;
      initialized = true;
      updateContext(((answer as { hostContext?: HostContext })?.hostContext ?? {}) as HostContext);
      post({ method: 'ui/notifications/initialized' });
    },
    () => fallBackToOpenAi(),
  );
  // A host without `window.openai` may simply be slow, so only ChatGPT's own
  // API ends the wait; otherwise a late answer still completes the handshake.
  setTimeout(() => {
    if (!initialized) fallBackToOpenAi();
  }, HANDSHAKE_TIMEOUT_MS);

  return {
    onToolResult(handler) {
      resultHandler = handler;
      if (lastResult) handler(lastResult);
    },
    onContext(handler) {
      contextHandler = handler;
      handler(context);
    },
    async openLink(url) {
      if (useOpenAi) {
        await win.openai?.openExternal?.({ href: url });
        return;
      }
      await request('ui/open-link', { url });
    },
    async sendMessage(text) {
      if (useOpenAi) {
        await win.openai?.sendFollowUpMessage?.({ prompt: text });
        return;
      }
      await request('ui/message', { role: 'user', content: [{ type: 'text', text }] });
    },
    reportSize(width, height) {
      if (!useOpenAi) post({ method: 'ui/notifications/size-changed', params: { width, height } });
    },
  };
}
