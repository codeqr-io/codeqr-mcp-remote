import { connect, type BridgeWindow, type HostContext, type ToolResult } from './bridge.js';
import { resolveLocale, stringsFor } from './i18n.js';
import { renderCard, toCardView } from './render.js';

const root = document.getElementById('root');
if (!root) throw new Error('item card: #root is missing');

// The real window has every member BridgeWindow names; the cast only narrows
// its overloaded addEventListener to the two events the bridge listens to.
const host = connect(window as unknown as BridgeWindow, { name: 'codeqr-item-card', version: '1' });

let context: HostContext = {};
let result: ToolResult | undefined;

function draw(target: HTMLElement): void {
  const doc = document.documentElement;
  doc.dataset.theme = context.theme === 'dark' ? 'dark' : 'light';
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
    if (name.startsWith('--') && typeof value === 'string') doc.style.setProperty(name, value);
  }
  const locale = resolveLocale(context.locale ?? (doc.lang || navigator.language));
  renderCard(target, toCardView(result), { strings: stringsFor(locale), locale }, {
    openLink: (url) => void host.openLink(url).catch(() => {}),
    sendMessage: (text) => void host.sendMessage(text).catch(() => {}),
    copy: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
  });
}

host.onContext((next) => {
  context = next;
  draw(root);
});
host.onToolResult((next) => {
  result = next;
  draw(root);
});

new ResizeObserver(() => {
  const { width, height } = document.body.getBoundingClientRect();
  host.reportSize(Math.ceil(width), Math.ceil(height));
}).observe(document.body);
