import { connect, type BridgeWindow, type HostContext, type ToolResult } from '../shared/bridge.js';
import { resolveLocale, stringsFor } from './i18n.js';
import { renderAnalytics, toAnalyticsView } from './render.js';

const root = document.getElementById('root');
if (!root) throw new Error('analytics card: #root is missing');

// The real window has every member BridgeWindow names; the cast only narrows
// its overloaded addEventListener to the two events the bridge listens to.
const host = connect(window as unknown as BridgeWindow, { name: 'codeqr-analytics', version: '1' });

let context: HostContext = {};
let result: ToolResult | undefined;
let loading = false;
let failed = false;
// Only the latest interval asked for may land, whatever order answers arrive in.
let request = 0;

function draw(target: HTMLElement): void {
  const doc = document.documentElement;
  doc.dataset.theme = context.theme === 'dark' ? 'dark' : 'light';
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
    if (name.startsWith('--') && typeof value === 'string') doc.style.setProperty(name, value);
  }
  const locale = resolveLocale(context.locale ?? (doc.lang || navigator.language));
  renderAnalytics(
    target,
    { view: toAnalyticsView(result), loading, failed, canSelect: host.canCallTools() },
    { strings: stringsFor(locale), locale },
    {
      openLink: (url) => void host.openLink(url).catch(() => {}),
      selectInterval: (interval) => void selectInterval(interval, target),
    },
  );
}

async function selectInterval(interval: string, target: HTMLElement): Promise<void> {
  const view = toAnalyticsView(result);
  if (!view || loading || view.query.interval === interval) return;
  const mine = ++request;
  loading = true;
  failed = false;
  draw(target);
  try {
    const next = await host.callTool('get_analytics', { ...view.query, interval });
    if (mine !== request) return;
    if (toAnalyticsView(next)) result = next;
    else failed = true;
  } catch {
    if (mine === request) failed = true;
  } finally {
    if (mine === request) {
      loading = false;
      draw(target);
    }
  }
}

host.onContext((next) => {
  context = next;
  draw(root);
});
host.onToolResult((next) => {
  result = next;
  failed = false;
  draw(root);
});

new ResizeObserver(() => {
  const { width, height } = document.body.getBoundingClientRect();
  host.reportSize(Math.ceil(width), Math.ceil(height));
}).observe(document.body);
