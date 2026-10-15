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

type Metric = 'clicks' | 'scans' | 'leads' | 'sales';
const METRICS: readonly Metric[] = ['clicks', 'scans', 'leads', 'sales'];

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
  /** A composite count, event by event, zeros left out. */
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

  const metric = metricOf(event, Boolean(query.qrcodeId));
  const card: AnalyticsCard = { kind: 'analytics', query, metric };

  if (groupBy === 'count') {
    if (!isRecord(result)) return undefined;
    card.total = valueOf(result, metric);
    if (event === 'composite') {
      const totals: Partial<Record<Metric, number>> = {};
      for (const each of METRICS) {
        const value = number(result[each]);
        if (value) totals[each] = value;
      }
      card.totals = totals;
    }
  } else if (groupBy === 'timeseries') {
    if (!Array.isArray(result)) return undefined;
    card.series = result.filter(isRecord).map((point) => ({ t: text(point.start) ?? '', v: valueOf(point, metric) }));
    card.total = card.series.reduce((sum, point) => sum + point.v, 0);
  } else {
    const label = ROW_LABEL[groupBy];
    if (!label || !Array.isArray(result)) return undefined;
    const rows = result
      .filter(isRecord)
      .map((row) => {
        const name = label(row);
        if (!name) return undefined;
        const entry: AnalyticsRow = { label: name, v: valueOf(row, metric) };
        const country = text(row.country);
        if ((groupBy === 'countries' || groupBy === 'cities') && country) entry.country = country;
        return entry;
      })
      .filter((row): row is AnalyticsRow => row !== undefined)
      .sort((a, b) => b.v - a.v);
    card.total = rows.reduce((sum, row) => sum + row.v, 0);
    card.rows = rows.slice(0, MAX_ROWS);
    if (rows.length > MAX_ROWS) card.more = rows.length - MAX_ROWS;
  }

  return {
    structuredContent: card,
    meta: { [ANALYTICS_META_KEY]: { dashboardUrl: dashboardUrlOf(query, metric, slug, appUrl) } },
  };
}

/** A composite query is read as the traffic of the code it names: scans for a QR code, clicks otherwise. */
function metricOf(event: string, isQrCode: boolean): Metric {
  if ((METRICS as readonly string[]).includes(event)) return event as Metric;
  return isQrCode ? 'scans' : 'clicks';
}

/**
 * The API moves a QR code's traffic from `clicks` to `scans` only in counts
 * and timeseries; breakdowns keep it in `clicks`, so a scan count falls back
 * to it.
 */
function valueOf(row: Record<string, unknown>, metric: Metric): number {
  if (metric === 'scans') return number(row.scans) || number(row.clicks);
  return number(row[metric]);
}

/**
 * The dashboard's analytics page filters by domain and key; a call that named
 * the code by id opens the code itself, since the API answer does not carry
 * its domain and key.
 */
function dashboardUrlOf(query: AnalyticsQuery, metric: Metric, slug: string | undefined, appUrl: string): string {
  if (!slug) return appUrl;
  if (query.qrcodeId) return `${appUrl}/${slug}/qrcodes/edit?id=${encodeURIComponent(query.qrcodeId)}`;
  if (query.linkId) return `${appUrl}/${slug}/links/edit?id=${encodeURIComponent(query.linkId)}`;

  const params = new URLSearchParams();
  if (query.domain && query.key) {
    params.set('domain', query.domain);
    params.set('key', query.key);
    params.set('type', metric === 'scans' ? 'qrcode' : 'link');
  }
  params.set('event', metric);
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
