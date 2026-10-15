/**
 * The data behind the analytics card, shown for get_analytics in hosts that
 * render MCP Apps. Like the item card (item-card.ts), `structuredContent` is
 * read by the model too, so it is a summary, not the API's raw rows; the
 * dashboard link goes in `_meta`, for the widget only.
 *
 * The card re-runs the call for another interval, so the summary carries the
 * query it came from.
 */

export const ANALYTICS_META_KEY = 'io.codeqr/analytics';

// The API's own default when the call names none.
const DEFAULT_INTERVAL = '24h';
const MAX_ROWS = 5;

/**
 * What a number on the card counts. `visits` is every click event — link
 * clicks, QR code scans and page views together — which is what the API
 * returns wherever it does not split traffic by kind.
 */
type Metric = 'visits' | 'clicks' | 'scans' | 'views' | 'leads' | 'sales';
const SPLIT: readonly Metric[] = ['clicks', 'scans', 'views', 'leads', 'sales'];

export type AnalyticsQuery = {
  event: string;
  groupBy: string;
  interval: string;
  linkId?: string;
  qrcodeId?: string;
  domain?: string;
  key?: string;
};

export type AnalyticsRow = { label: string; v: number; country?: string };

export type AnalyticsCard = {
  kind: 'analytics';
  query: AnalyticsQuery;
  /** What every number on the card counts. */
  metric: Metric;
  total?: number;
  /** A composite count, kind by kind, zeros left out. */
  totals?: Partial<Record<Metric, number>>;
  series?: Array<{ t: string; v: number }>;
  rows?: AnalyticsRow[];
  /** Rows past the first MAX_ROWS. */
  more?: number;
};

export type AnalyticsMeta = { dashboardUrl: string };

// How a breakdown row is named, by groupBy.
const ROW_LABEL: Record<string, (row: Record<string, unknown>) => string | undefined> = {
  countries: (row) => text(row.country),
  cities: (row) => text(row.city),
  devices: (row) => text(row.device),
  browsers: (row) => text(row.browser),
  os: (row) => text(row.os),
  referers: (row) => text(row.referer),
  top_links: shortLinkLabel,
  top_qrcodes: shortLinkLabel,
  top_urls: (row) => text(row.url)?.replace(/^https?:\/\//, ''),
};

export function buildAnalyticsCard(
  args: Record<string, unknown>,
  result: unknown,
  { slug, appUrl }: { slug: string | undefined; appUrl: string },
): { structuredContent: AnalyticsCard; meta: Record<string, AnalyticsMeta> } | undefined {
  const event = text(args.event);
  const groupBy = text(args.groupBy);
  if (!event || !groupBy) return undefined;

  const query: AnalyticsQuery = { event, groupBy, interval: text(args.interval) ?? DEFAULT_INTERVAL };
  for (const field of ['linkId', 'qrcodeId', 'domain', 'key'] as const) {
    const value = text(args[field]);
    if (value) query[field] = value;
  }

  const scope = query.qrcodeId ? 'qrcode' : query.linkId ? 'link' : 'all';
  const isTop = groupBy.startsWith('top_');

  if (groupBy === 'count') {
    if (!isRecord(result)) return undefined;
    const metric = metricOf(event, scope, groupBy);
    const card: AnalyticsCard = { kind: 'analytics', query, metric, total: valueOf(result, metric, groupBy) };
    if (event === 'composite') {
      const totals: Partial<Record<Metric, number>> = {};
      for (const each of SPLIT) {
        const value = number(result[each]);
        if (value) totals[each] = value;
      }
      card.totals = totals;
    }
    return withMeta(card, slug, appUrl);
  }

  if (groupBy === 'timeseries') {
    if (!Array.isArray(result)) return undefined;
    const points = result.filter(isRecord);
    const metric = metricOf(event, scope, groupBy);
    const series = points.map((point) => ({ t: text(point.start) ?? '', v: valueOf(point, metric, groupBy) }));
    const total = series.reduce((sum, point) => sum + point.v, 0);
    return withMeta({ kind: 'analytics', query, metric, total, series }, slug, appUrl);
  }

  const label = ROW_LABEL[groupBy];
  if (!label || !Array.isArray(result)) return undefined;
  const metric = metricOf(event, scope, groupBy);
  const rows = result
    .filter(isRecord)
    .map((row) => {
      const name = label(row);
      if (!name) return undefined;
      const entry: AnalyticsRow = { label: name, v: valueOf(row, metric, groupBy) };
      const country = text(row.country);
      if ((groupBy === 'countries' || groupBy === 'cities') && country) entry.country = country;
      return entry;
    })
    .filter((row): row is AnalyticsRow => row !== undefined)
    .sort((a, b) => b.v - a.v);
  const card: AnalyticsCard = { kind: 'analytics', query, metric, rows: rows.slice(0, MAX_ROWS) };
  // A top list is cut by the API, so its rows do not add up to the period's total.
  if (!isTop) card.total = rows.reduce((sum, row) => sum + row.v, 0);
  if (rows.length > MAX_ROWS) card.more = rows.length - MAX_ROWS;
  return withMeta(card, slug, appUrl);
}

function withMeta(card: AnalyticsCard, slug: string | undefined, appUrl: string) {
  return {
    structuredContent: card,
    meta: { [ANALYTICS_META_KEY]: { dashboardUrl: dashboardUrlOf(card.query, slug, appUrl) } },
  };
}

/**
 * What the numbers count. get_analytics sends resolveAnalyticsQuery's request
 * (analytics-query.ts): a code by id, or "scans" and "clicks" over the
 * workspace filtered to QR codes or links, so the event asked for holds.
 * Only a composite query over the workspace counts every kind together.
 */
function metricOf(event: string, scope: 'qrcode' | 'link' | 'all', groupBy: string): Metric {
  if (event === 'leads' || event === 'sales') return event;
  if (scope === 'qrcode') return 'scans';
  if (scope === 'link') return 'clicks';
  // A top list is of one kind, whatever the event.
  if (groupBy === 'top_qrcodes') return 'scans';
  if (groupBy === 'top_links') return 'clicks';
  if (event === 'scans') return 'scans';
  if (event === 'clicks') return 'clicks';
  return 'visits';
}

function isSplit(row: Record<string, unknown>): boolean {
  return typeof row.scans === 'number' || typeof row.views === 'number';
}

/**
 * Counts and timeseries carry scans in `scans`: the API moves a QR code's
 * traffic there, and splits workspace traffic by kind. Breakdowns, filtered
 * to one QR code or to QR codes, keep it in `clicks`; top_qrcodes names it
 * `scans`. Split visits add the three kinds back up.
 */
function valueOf(row: Record<string, unknown>, metric: Metric, groupBy: string): number {
  if (metric === 'scans') {
    return groupBy === 'count' || groupBy === 'timeseries' || groupBy === 'top_qrcodes'
      ? number(row.scans)
      : number(row.clicks);
  }
  if (metric === 'visits') return isSplit(row) ? number(row.clicks) + number(row.scans) + number(row.views) : number(row.clicks);
  return number(row[metric]);
}

/**
 * A code named by id opens its own page: the API answer does not carry its
 * domain and key. A key without a type is ignored by the analytics API, so
 * the numbers, and the page, are the whole domain's.
 */
function dashboardUrlOf(query: AnalyticsQuery, slug: string | undefined, appUrl: string): string {
  if (!slug) return appUrl;
  if (query.qrcodeId) return `${appUrl}/${slug}/qrcodes/edit?id=${encodeURIComponent(query.qrcodeId)}`;
  if (query.linkId) return `${appUrl}/${slug}/links/edit?id=${encodeURIComponent(query.linkId)}`;

  const params = new URLSearchParams();
  if (query.domain) params.set('domain', query.domain);
  params.set('interval', query.interval);
  return `${appUrl}/${slug}/analytics?${params.toString()}`;
}

function shortLinkLabel(row: Record<string, unknown>): string | undefined {
  const shortLink = text(row.shortLink);
  if (shortLink) return shortLink.replace(/^https?:\/\//, '');
  const domain = text(row.domain);
  const key = text(row.key);
  return domain && key ? `${domain}/${key}` : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
