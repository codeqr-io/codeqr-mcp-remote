// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { resolveLocale, stringsFor } from '../web/analytics/i18n.js';
import { LOCALES } from '../web/shared/locale.js';
import {
  ANALYTICS_META_KEY,
  renderAnalytics,
  toAnalyticsView,
  type AnalyticsActions,
  type AnalyticsState,
} from '../web/analytics/render.js';

const DASHBOARD = 'https://app.codeqr.io/acme/analytics?domain=freeqr.ink&key=menu-qr&type=qrcode&event=scans&interval=7d';

const result = (content: Record<string, unknown>, meta: Record<string, unknown> = { dashboardUrl: DASHBOARD }) => ({
  structuredContent: {
    kind: 'analytics',
    query: { event: 'scans', groupBy: 'count', interval: '7d', domain: 'freeqr.ink', key: 'menu-qr' },
    metric: 'scans',
    ...content,
  },
  _meta: { [ANALYTICS_META_KEY]: meta },
});

function render(raw: unknown, { locale = 'en', ...state }: Partial<AnalyticsState> & { locale?: string } = {}) {
  const root = document.createElement('div');
  const actions = { openLink: vi.fn(), selectInterval: vi.fn() } satisfies AnalyticsActions;
  const resolved = resolveLocale(locale);
  renderAnalytics(
    root,
    { view: toAnalyticsView(raw as never), loading: false, failed: false, canSelect: false, ...state },
    { strings: stringsFor(resolved), locale: resolved },
    actions,
  );
  return { root, actions };
}

const text = (root: HTMLElement, selector: string) => root.querySelector(selector)?.textContent;

describe('toAnalyticsView', () => {
  it('renders nothing for an error, another card, an unknown metric or a missing query', () => {
    expect(toAnalyticsView({ ...result({ total: 1 }), isError: true })).toBeNull();
    expect(toAnalyticsView({ structuredContent: { kind: 'qrcode' } })).toBeNull();
    expect(toAnalyticsView(result({ metric: 'views' }) as never)).toBeNull();
    expect(toAnalyticsView(result({ query: { groupBy: 'count' } }) as never)).toBeNull();
  });

  it('drops a non-https dashboard link, bad counts and country codes it does not expect', () => {
    const view = toAnalyticsView(
      result(
        { total: -3, rows: [{ label: 'BR', v: 2, country: 'br<script>' }] },
        { dashboardUrl: 'javascript:alert(1)' },
      ) as never,
    );

    expect(view?.dashboardUrl).toBeUndefined();
    expect(view?.total).toBeUndefined();
    expect(view?.rows).toEqual([{ label: 'BR', v: 2 }]);
  });
});

describe('renderAnalytics', () => {
  it('shows what is counted, for which code and period, and the total', () => {
    const { root } = render(result({ total: 1234 }), { locale: 'pt-BR' });

    expect(text(root, '.caption')).toBe('Scans · freeqr.ink/menu-qr');
    expect(text(root, '.period')).toBe('Últimos 7 dias');
    expect(text(root, '.total')).toBe('1.234');
  });

  it('shows each event of a composite count', () => {
    const { root } = render(result({ metric: 'clicks', total: 10, totals: { scans: 5, clicks: 10, leads: 2 } }));

    expect([...root.querySelectorAll('.tile .label')].map((node) => node.textContent)).toEqual(['Clicks', 'Scans', 'Leads']);
  });

  it('draws a trend line with the first and last dates', () => {
    const { root } = render(
      result({
        query: { event: 'scans', groupBy: 'timeseries', interval: '7d' },
        total: 10,
        series: [
          { t: '2026-10-08T00:00:00.000Z', v: 3 },
          { t: '2026-10-09T00:00:00.000Z', v: 0 },
          { t: '2026-10-10T00:00:00.000Z', v: 7 },
        ],
      }),
    );

    expect(root.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(3);
    const [first, last] = [...root.querySelectorAll('.axis span')].map((node) => node.textContent);
    expect(first).toContain('8');
    expect(last).toContain('10');
  });

  it('names countries in the user language with their flag, and scales the bars', () => {
    const { root } = render(
      result({
        query: { event: 'scans', groupBy: 'countries', interval: '30d' },
        total: 12,
        rows: [
          { label: 'BR', v: 9, country: 'BR' },
          { label: 'US', v: 3, country: 'US' },
        ],
        more: 4,
      }),
      { locale: 'pt-BR' },
    );

    expect(text(root, '.section')).toBe('Países');
    expect(text(root, '.row .name')).toBe('🇧🇷 Brasil');
    const widths = [...root.querySelectorAll<HTMLElement>('.fill')].map((node) => node.style.width);
    expect(widths).toEqual(['100%', '33%']);
    expect(text(root, '.more')).toBe('+4 outros');
  });

  it('translates direct traffic and keeps any other label as text', () => {
    const { root } = render(
      result({
        query: { event: 'clicks', groupBy: 'referers', interval: '7d' },
        metric: 'clicks',
        rows: [
          { label: '(direct)', v: 3 },
          { label: '<img src=x onerror="alert(1)">', v: 1 },
        ],
      }),
    );

    const names = [...root.querySelectorAll('.row .name')].map((node) => node.textContent);
    expect(names).toEqual(['Direct', '<img src=x onerror="alert(1)">']);
    expect(root.querySelector('img')).toBeNull();
  });

  it('says when the period had no activity instead of drawing an empty chart', () => {
    const { root } = render(
      result({ query: { event: 'scans', groupBy: 'timeseries', interval: '24h' }, total: 0, series: [{ t: 'a', v: 0 }, { t: 'b', v: 0 }] }),
    );

    expect(text(root, '.empty')).toBe('No activity in this period.');
    expect(root.querySelector('svg')).toBeNull();
  });

  it('offers the interval chips only when the host can run the call, marking the current one', () => {
    const without = render(result({ total: 1 }));
    const { root, actions } = render(result({ total: 1 }), { canSelect: true });

    expect(without.root.querySelector('.chips')).toBeNull();
    const chips = [...root.querySelectorAll<HTMLButtonElement>('.chip')];
    expect(chips.map((chip) => chip.textContent)).toEqual(['24h', '7d', '30d']);
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    chips[2].click();
    expect(actions.selectInterval).toHaveBeenCalledWith('30d');
  });

  it('disables the chips while loading and says when a period failed', () => {
    const loading = render(result({ total: 1 }), { canSelect: true, loading: true });
    const failed = render(result({ total: 1 }), { canSelect: true, failed: true, locale: 'pt-BR' });

    expect([...loading.root.querySelectorAll('.chip')].every((chip) => chip.hasAttribute('disabled'))).toBe(true);
    expect(text(loading.root, '.status')).toBe('Updating…');
    expect(text(failed.root, '.status.failed')).toBe('Não foi possível carregar este período.');
  });

  it('opens the dashboard analytics', () => {
    const { root, actions } = render(result({ total: 1 }));

    (root.querySelector('button.primary') as HTMLButtonElement).click();
    expect(actions.openLink).toHaveBeenCalledWith(DASHBOARD);
  });
});

describe('analytics labels', () => {
  it('has every label in every locale', () => {
    const shape = (value: unknown): unknown =>
      typeof value === 'object' && value !== null
        ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)]))
        : typeof value;
    const english = shape(stringsFor('en'));
    for (const locale of LOCALES) {
      const strings = stringsFor(locale);
      expect(shape(strings), locale).toEqual(english);
      expect(strings.more, locale).toContain('{n}');
    }
  });
});
