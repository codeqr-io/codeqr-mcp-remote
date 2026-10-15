/**
 * Turns a get_analytics result into the card. As in the item card, the result
 * is untrusted: every field is type-checked and capped, text only goes
 * through textContent, and the chart is built with DOM calls, never markup.
 */

import type { ToolResult } from '../shared/bridge.js';
import type { Strings } from './i18n.js';

export const ANALYTICS_META_KEY = 'io.codeqr/analytics';
/** Every plan can read these, so the card never offers a window that answers with an error. */
export const SELECTABLE_INTERVALS = ['24h', '7d', '30d'] as const;

const METRICS = ['clicks', 'scans', 'leads', 'sales'] as const;
type Metric = (typeof METRICS)[number];
const MAX_POINTS = 400;
const MAX_ROWS = 10;
const SVG = 'http://www.w3.org/2000/svg';

export interface AnalyticsQuery {
  event: string;
  groupBy: string;
  interval: string;
  [filter: string]: string;
}

export interface AnalyticsView {
  query: AnalyticsQuery;
  metric: Metric;
  total?: number;
  totals: Array<[Metric, number]>;
  series?: Array<{ t: string; v: number }>;
  rows?: Array<{ label: string; v: number; country?: string }>;
  more?: number;
  dashboardUrl?: string;
}

export interface AnalyticsState {
  view: AnalyticsView | null;
  loading: boolean;
  failed: boolean;
  canSelect: boolean;
}

export interface AnalyticsActions {
  openLink(url: string): void;
  selectInterval(interval: string): void;
}

export function toAnalyticsView(result: ToolResult | undefined): AnalyticsView | null {
  if (!result || result.isError) return null;
  const content = record(result.structuredContent);
  if (!content || content.kind !== 'analytics') return null;
  const metric = content.metric;
  if (!isMetric(metric)) return null;

  const rawQuery = record(content.query);
  if (!rawQuery || !text(rawQuery.event) || !text(rawQuery.groupBy) || !text(rawQuery.interval)) return null;
  const query = {} as AnalyticsQuery;
  for (const field of ['event', 'groupBy', 'interval', 'linkId', 'qrcodeId', 'domain', 'key']) {
    const value = text(rawQuery[field]);
    if (value) query[field] = value;
  }

  const totals = Object.entries(record(content.totals) ?? {})
    .filter((entry): entry is [Metric, number] => isMetric(entry[0]) && count(entry[1]) !== undefined)
    .sort((a, b) => METRICS.indexOf(a[0]) - METRICS.indexOf(b[0]));

  const series = Array.isArray(content.series)
    ? content.series
        .slice(0, MAX_POINTS)
        .map(record)
        .filter((point): point is Record<string, unknown> => point !== undefined)
        .map((point) => ({ t: text(point.t) ?? '', v: count(point.v) ?? 0 }))
    : undefined;

  const rows = Array.isArray(content.rows)
    ? content.rows
        .slice(0, MAX_ROWS)
        .map(record)
        .filter((row): row is Record<string, unknown> => row !== undefined && text(row.label) !== undefined)
        .map((row) => {
          const country = text(row.country);
          return {
            label: text(row.label) as string,
            v: count(row.v) ?? 0,
            ...(country && /^[A-Z]{2}$/.test(country) ? { country } : {}),
          };
        })
    : undefined;

  const dashboardUrl = https(record(record(result._meta)?.[ANALYTICS_META_KEY])?.dashboardUrl);

  return {
    query,
    metric,
    total: count(content.total),
    totals,
    series,
    rows,
    more: count(content.more),
    dashboardUrl,
  };
}

export function renderAnalytics(
  root: HTMLElement,
  state: AnalyticsState,
  { strings, locale }: { strings: Strings; locale: string },
  actions: AnalyticsActions,
): void {
  root.replaceChildren();
  const { view } = state;
  if (!view) return;

  const card = el('article', 'card');
  const numbers = new Intl.NumberFormat(locale);

  const head = el('header', 'head');
  const subject = view.query.domain && view.query.key ? `${view.query.domain}/${view.query.key}` : undefined;
  head.append(el('p', 'caption', subject ? `${strings.metrics[view.metric]} · ${subject}` : strings.metrics[view.metric]));
  head.append(el('p', 'period', intervalName(view.query.interval, strings)));
  if (view.total !== undefined) head.append(el('p', 'total', numbers.format(view.total)));
  card.append(head);

  if (view.totals.length > 1) {
    const tiles = el('div', 'tiles');
    for (const [metric, value] of view.totals) {
      const tile = el('div', 'tile');
      tile.append(el('span', 'label', strings.metrics[metric]), el('span', 'value', numbers.format(value)));
      tiles.append(tile);
    }
    card.append(tiles);
  }

  const empty =
    view.total === 0 && !view.totals.length && (!view.rows || !view.rows.length) && !view.series?.some((point) => point.v > 0);
  if (empty) {
    card.append(el('p', 'empty', strings.empty));
  } else {
    if (view.series && view.series.length > 1) card.append(sparkline(view.series, view.query.interval, locale));
    if (view.rows?.length) card.append(rows(view, strings, locale, numbers));
  }

  if (state.canSelect) {
    const chips = el('div', 'chips');
    for (const interval of SELECTABLE_INTERVALS) {
      const chip = el('button', 'chip', interval);
      chip.setAttribute('type', 'button');
      chip.setAttribute('aria-pressed', String(interval === view.query.interval));
      if (state.loading) chip.setAttribute('disabled', '');
      chip.addEventListener('click', () => actions.selectInterval(interval));
      chips.append(chip);
    }
    card.append(chips);
  }

  if (state.loading || state.failed) {
    card.append(el('p', state.failed ? 'status failed' : 'status', state.failed ? strings.failed : strings.loading));
  }

  if (view.dashboardUrl) {
    const dashboardUrl = view.dashboardUrl;
    const open = el('button', 'primary', strings.open);
    open.setAttribute('type', 'button');
    open.addEventListener('click', () => actions.openLink(dashboardUrl));
    const footer = el('div', 'actions');
    footer.append(open);
    card.append(footer);
  }

  root.append(card);
}

function rows(view: AnalyticsView, strings: Strings, locale: string, numbers: Intl.NumberFormat): HTMLElement {
  const section = el('section', 'rows');
  const title = (strings.sections as Record<string, string>)[view.query.groupBy];
  if (title) section.append(el('h3', 'section', title));

  const max = Math.max(...(view.rows ?? []).map((row) => row.v), 1);
  for (const row of view.rows ?? []) {
    const line = el('div', 'row');
    const name = el('span', 'name', rowName(row, view.query.groupBy, strings, locale));
    const value = el('span', 'value', numbers.format(row.v));
    const bar = el('span', 'bar');
    const fill = el('span', 'fill');
    fill.style.width = `${Math.round((row.v / max) * 100)}%`;
    bar.append(fill);
    line.append(name, value, bar);
    section.append(line);
  }
  if (view.more) section.append(el('p', 'more', strings.more.replace('{n}', numbers.format(view.more))));
  return section;
}

function rowName(row: { label: string; country?: string }, groupBy: string, strings: Strings, locale: string): string {
  if (groupBy === 'referers' && row.label === '(direct)') return strings.direct;
  if (groupBy === 'countries' && row.country) return `${flag(row.country)} ${regionName(row.country, locale)}`;
  if (groupBy === 'cities' && row.country) return `${flag(row.country)} ${row.label}`;
  return row.label;
}

function sparkline(series: Array<{ t: string; v: number }>, interval: string, locale: string): HTMLElement {
  const wrap = el('figure', 'trend');
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 100 32');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const max = Math.max(...series.map((point) => point.v), 1);
  const points = series.map((point, i) => {
    const x = (i / (series.length - 1)) * 100;
    const y = 30 - (point.v / max) * 28;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const area = document.createElementNS(SVG, 'polygon');
  area.setAttribute('points', `0,32 ${points.join(' ')} 100,32`);
  area.setAttribute('class', 'area');
  const line = document.createElementNS(SVG, 'polyline');
  line.setAttribute('points', points.join(' '));
  line.setAttribute('class', 'line');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(area, line);

  const axis = el('figcaption', 'axis');
  axis.append(el('span', '', dateLabel(series[0].t, interval, locale)), el('span', '', dateLabel(series[series.length - 1].t, interval, locale)));
  wrap.append(svg, axis);
  return wrap;
}

function dateLabel(iso: string, interval: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  // Day and month buckets start at midnight UTC (the call sends no timezone),
  // so they are named in UTC; in the user's own zone the 8th could read as the 7th.
  const options: Intl.DateTimeFormatOptions =
    interval === '1h' || interval === '24h'
      ? { hour: '2-digit', minute: '2-digit' }
      : interval === '7d' || interval === '30d'
        ? { day: 'numeric', month: 'short', timeZone: 'UTC' }
        : { month: 'short', year: 'numeric', timeZone: 'UTC' };
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function intervalName(interval: string, strings: Strings): string {
  return (strings.intervals as Record<string, string>)[interval] ?? interval;
}

function regionName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function flag(code: string): string {
  return String.fromCodePoint(...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function isMetric(value: unknown): value is Metric {
  return typeof value === 'string' && (METRICS as readonly string[]).includes(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function https(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}
