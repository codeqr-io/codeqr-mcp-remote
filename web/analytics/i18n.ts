/**
 * Labels for the analytics card in the CodeQR app's locales; anything else
 * falls back to English. Counts sit under a caption, so no plural forms.
 */

import type { Locale } from '../shared/locale.js';

export { resolveLocale } from '../shared/locale.js';

type Metric = 'clicks' | 'scans' | 'leads' | 'sales';
type Interval = '1h' | '24h' | '7d' | '30d' | '90d' | 'ytd' | '1y' | 'all';
type Section = 'countries' | 'cities' | 'devices' | 'browsers' | 'os' | 'referers' | 'top_links' | 'top_qrcodes' | 'top_urls';

export interface Strings {
  metrics: Record<Metric, string>;
  intervals: Record<Interval, string>;
  sections: Record<Section, string>;
  direct: string;
  open: string;
  loading: string;
  failed: string;
  empty: string;
  /** `{n}` is replaced by the number of rows left out. */
  more: string;
}

const STRINGS: Record<Locale, Strings> = {
  en: {
    metrics: { clicks: 'Clicks', scans: 'Scans', leads: 'Leads', sales: 'Sales' },
    intervals: { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', ytd: 'Year to date', '1y': 'Last 12 months', all: 'All time' },
    sections: { countries: 'Countries', cities: 'Cities', devices: 'Devices', browsers: 'Browsers', os: 'Operating systems', referers: 'Referrers', top_links: 'Top links', top_qrcodes: 'Top QR codes', top_urls: 'Top destinations' },
    direct: 'Direct',
    open: 'Open analytics',
    loading: 'Updating…',
    failed: 'This period could not be loaded.',
    empty: 'No activity in this period.',
    more: '+{n} more',
  },
  'pt-br': {
    metrics: { clicks: 'Cliques', scans: 'Scans', leads: 'Leads', sales: 'Vendas' },
    intervals: { '1h': 'Última hora', '24h': 'Últimas 24 horas', '7d': 'Últimos 7 dias', '30d': 'Últimos 30 dias', '90d': 'Últimos 90 dias', ytd: 'Este ano', '1y': 'Últimos 12 meses', all: 'Todo o período' },
    sections: { countries: 'Países', cities: 'Cidades', devices: 'Dispositivos', browsers: 'Navegadores', os: 'Sistemas operacionais', referers: 'Origens', top_links: 'Links principais', top_qrcodes: 'QR codes principais', top_urls: 'Destinos principais' },
    direct: 'Direto',
    open: 'Abrir analytics',
    loading: 'Atualizando…',
    failed: 'Não foi possível carregar este período.',
    empty: 'Sem atividade neste período.',
    more: '+{n} outros',
  },
  'pt-pt': {
    metrics: { clicks: 'Cliques', scans: 'Leituras', leads: 'Leads', sales: 'Vendas' },
    intervals: { '1h': 'Última hora', '24h': 'Últimas 24 horas', '7d': 'Últimos 7 dias', '30d': 'Últimos 30 dias', '90d': 'Últimos 90 dias', ytd: 'Este ano', '1y': 'Últimos 12 meses', all: 'Todo o período' },
    sections: { countries: 'Países', cities: 'Cidades', devices: 'Dispositivos', browsers: 'Navegadores', os: 'Sistemas operativos', referers: 'Origens', top_links: 'Links principais', top_qrcodes: 'Códigos QR principais', top_urls: 'Destinos principais' },
    direct: 'Direto',
    open: 'Abrir analytics',
    loading: 'A atualizar…',
    failed: 'Não foi possível carregar este período.',
    empty: 'Sem atividade neste período.',
    more: '+{n} outros',
  },
  es: {
    metrics: { clicks: 'Clics', scans: 'Escaneos', leads: 'Leads', sales: 'Ventas' },
    intervals: { '1h': 'Última hora', '24h': 'Últimas 24 horas', '7d': 'Últimos 7 días', '30d': 'Últimos 30 días', '90d': 'Últimos 90 días', ytd: 'Este año', '1y': 'Últimos 12 meses', all: 'Todo el período' },
    sections: { countries: 'Países', cities: 'Ciudades', devices: 'Dispositivos', browsers: 'Navegadores', os: 'Sistemas operativos', referers: 'Orígenes', top_links: 'Enlaces principales', top_qrcodes: 'Códigos QR principales', top_urls: 'Destinos principales' },
    direct: 'Directo',
    open: 'Abrir analytics',
    loading: 'Actualizando…',
    failed: 'No se pudo cargar este período.',
    empty: 'Sin actividad en este período.',
    more: '+{n} más',
  },
  fr: {
    metrics: { clicks: 'Clics', scans: 'Scans', leads: 'Leads', sales: 'Ventes' },
    intervals: { '1h': 'Dernière heure', '24h': 'Dernières 24 heures', '7d': '7 derniers jours', '30d': '30 derniers jours', '90d': '90 derniers jours', ytd: 'Cette année', '1y': '12 derniers mois', all: 'Depuis le début' },
    sections: { countries: 'Pays', cities: 'Villes', devices: 'Appareils', browsers: 'Navigateurs', os: "Systèmes d'exploitation", referers: 'Provenances', top_links: 'Liens principaux', top_qrcodes: 'QR codes principaux', top_urls: 'Destinations principales' },
    direct: 'Direct',
    open: 'Ouvrir les statistiques',
    loading: 'Mise à jour…',
    failed: "Impossible de charger cette période.",
    empty: 'Aucune activité sur cette période.',
    more: '+{n} autres',
  },
  de: {
    metrics: { clicks: 'Klicks', scans: 'Scans', leads: 'Leads', sales: 'Verkäufe' },
    intervals: { '1h': 'Letzte Stunde', '24h': 'Letzte 24 Stunden', '7d': 'Letzte 7 Tage', '30d': 'Letzte 30 Tage', '90d': 'Letzte 90 Tage', ytd: 'Dieses Jahr', '1y': 'Letzte 12 Monate', all: 'Gesamter Zeitraum' },
    sections: { countries: 'Länder', cities: 'Städte', devices: 'Geräte', browsers: 'Browser', os: 'Betriebssysteme', referers: 'Herkunft', top_links: 'Top-Links', top_qrcodes: 'Top-QR-Codes', top_urls: 'Top-Ziele' },
    direct: 'Direkt',
    open: 'Analytics öffnen',
    loading: 'Wird aktualisiert…',
    failed: 'Dieser Zeitraum konnte nicht geladen werden.',
    empty: 'Keine Aktivität in diesem Zeitraum.',
    more: '+{n} weitere',
  },
  it: {
    metrics: { clicks: 'Clic', scans: 'Scansioni', leads: 'Lead', sales: 'Vendite' },
    intervals: { '1h': 'Ultima ora', '24h': 'Ultime 24 ore', '7d': 'Ultimi 7 giorni', '30d': 'Ultimi 30 giorni', '90d': 'Ultimi 90 giorni', ytd: "Quest'anno", '1y': 'Ultimi 12 mesi', all: 'Tutto il periodo' },
    sections: { countries: 'Paesi', cities: 'Città', devices: 'Dispositivi', browsers: 'Browser', os: 'Sistemi operativi', referers: 'Provenienze', top_links: 'Link principali', top_qrcodes: 'Codici QR principali', top_urls: 'Destinazioni principali' },
    direct: 'Diretto',
    open: 'Apri analytics',
    loading: 'Aggiornamento…',
    failed: 'Impossibile caricare questo periodo.',
    empty: 'Nessuna attività in questo periodo.',
    more: '+{n} altri',
  },
  ru: {
    metrics: { clicks: 'Переходы', scans: 'Сканирования', leads: 'Лиды', sales: 'Продажи' },
    intervals: { '1h': 'Последний час', '24h': 'Последние 24 часа', '7d': 'Последние 7 дней', '30d': 'Последние 30 дней', '90d': 'Последние 90 дней', ytd: 'С начала года', '1y': 'Последние 12 месяцев', all: 'За всё время' },
    sections: { countries: 'Страны', cities: 'Города', devices: 'Устройства', browsers: 'Браузеры', os: 'Операционные системы', referers: 'Источники', top_links: 'Лучшие ссылки', top_qrcodes: 'Лучшие QR-коды', top_urls: 'Лучшие адреса' },
    direct: 'Прямые',
    open: 'Открыть аналитику',
    loading: 'Обновление…',
    failed: 'Не удалось загрузить этот период.',
    empty: 'Нет активности за этот период.',
    more: 'Ещё {n}',
  },
  zh: {
    metrics: { clicks: '点击次数', scans: '扫描次数', leads: '潜在客户', sales: '销售' },
    intervals: { '1h': '过去1小时', '24h': '过去24小时', '7d': '过去7天', '30d': '过去30天', '90d': '过去90天', ytd: '今年至今', '1y': '过去12个月', all: '全部时间' },
    sections: { countries: '国家/地区', cities: '城市', devices: '设备', browsers: '浏览器', os: '操作系统', referers: '来源', top_links: '热门链接', top_qrcodes: '热门二维码', top_urls: '热门目标网址' },
    direct: '直接访问',
    open: '打开分析',
    loading: '正在更新…',
    failed: '无法加载此时间段。',
    empty: '此时间段内没有活动。',
    more: '另外 {n} 项',
  },
  ja: {
    metrics: { clicks: 'クリック数', scans: 'スキャン数', leads: 'リード', sales: '売上' },
    intervals: { '1h': '過去1時間', '24h': '過去24時間', '7d': '過去7日間', '30d': '過去30日間', '90d': '過去90日間', ytd: '今年', '1y': '過去12か月', all: '全期間' },
    sections: { countries: '国・地域', cities: '都市', devices: 'デバイス', browsers: 'ブラウザ', os: 'OS', referers: '参照元', top_links: '上位のリンク', top_qrcodes: '上位の QR コード', top_urls: '上位の遷移先' },
    direct: '直接',
    open: 'アナリティクスを開く',
    loading: '更新中…',
    failed: 'この期間を読み込めませんでした。',
    empty: 'この期間のアクティビティはありません。',
    more: 'ほか {n} 件',
  },
  ko: {
    metrics: { clicks: '클릭 수', scans: '스캔 수', leads: '리드', sales: '판매' },
    intervals: { '1h': '최근 1시간', '24h': '최근 24시간', '7d': '최근 7일', '30d': '최근 30일', '90d': '최근 90일', ytd: '올해', '1y': '최근 12개월', all: '전체 기간' },
    sections: { countries: '국가', cities: '도시', devices: '기기', browsers: '브라우저', os: '운영체제', referers: '유입 경로', top_links: '상위 링크', top_qrcodes: '상위 QR 코드', top_urls: '상위 목적지' },
    direct: '직접',
    open: '분석 열기',
    loading: '업데이트 중…',
    failed: '이 기간을 불러오지 못했습니다.',
    empty: '이 기간에는 활동이 없습니다.',
    more: '외 {n}개',
  },
};

export function stringsFor(locale: Locale): Strings {
  return STRINGS[locale];
}
