/**
 * Labels for the item card in the CodeQR app's locales. The host tells the
 * widget the user's language; anything not listed here falls back to English.
 */

export const LOCALES = ['pt-br', 'pt-pt', 'en', 'es', 'fr', 'de', 'zh', 'ru', 'it', 'ja', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];

export interface Strings {
  dynamic: string;
  static: string;
  archived: string;
  /** Caption above the count, so no plural forms are needed. */
  scans: string;
  clicks: string;
  open: string;
  seeScans: string;
  seeClicks: string;
  copy: string;
  copied: string;
  /** `{link}` is replaced by the short link. */
  qrAlt: string;
  askScans: string;
  askClicks: string;
  types: Record<'text' | 'phone' | 'email' | 'sms' | 'wifi' | 'vcard' | 'crypto' | 'whatsapp', string>;
}

const STRINGS: Record<Locale, Strings> = {
  en: {
    dynamic: 'Dynamic · destination can change',
    static: 'Static',
    archived: 'Archived',
    scans: 'Scans',
    clicks: 'Clicks',
    open: 'Open in CodeQR',
    seeScans: 'See scans',
    seeClicks: 'See clicks',
    copy: 'Copy',
    copied: 'Copied',
    qrAlt: 'QR code for {link}',
    askScans: 'How many scans has {link} had in the last 30 days?',
    askClicks: 'How many clicks has {link} had in the last 30 days?',
    types: { text: 'Text', phone: 'Phone', email: 'Email', sms: 'SMS', wifi: 'Wi-Fi', vcard: 'Contact card', crypto: 'Crypto', whatsapp: 'WhatsApp' },
  },
  'pt-br': {
    dynamic: 'Dinâmico · o destino pode mudar',
    static: 'Estático',
    archived: 'Arquivado',
    scans: 'Scans',
    clicks: 'Cliques',
    open: 'Abrir na CodeQR',
    seeScans: 'Ver scans',
    seeClicks: 'Ver cliques',
    copy: 'Copiar',
    copied: 'Copiado',
    qrAlt: 'QR code de {link}',
    askScans: 'Quantos scans {link} teve nos últimos 30 dias?',
    askClicks: 'Quantos cliques {link} teve nos últimos 30 dias?',
    types: { text: 'Texto', phone: 'Telefone', email: 'E-mail', sms: 'SMS', wifi: 'Wi-Fi', vcard: 'Cartão de contato', crypto: 'Cripto', whatsapp: 'WhatsApp' },
  },
  'pt-pt': {
    dynamic: 'Dinâmico · o destino pode mudar',
    static: 'Estático',
    archived: 'Arquivado',
    scans: 'Leituras',
    clicks: 'Cliques',
    open: 'Abrir no CodeQR',
    seeScans: 'Ver leituras',
    seeClicks: 'Ver cliques',
    copy: 'Copiar',
    copied: 'Copiado',
    qrAlt: 'Código QR de {link}',
    askScans: 'Quantas leituras teve {link} nos últimos 30 dias?',
    askClicks: 'Quantos cliques teve {link} nos últimos 30 dias?',
    types: { text: 'Texto', phone: 'Telefone', email: 'E-mail', sms: 'SMS', wifi: 'Wi-Fi', vcard: 'Cartão de contacto', crypto: 'Cripto', whatsapp: 'WhatsApp' },
  },
  es: {
    dynamic: 'Dinámico · el destino puede cambiar',
    static: 'Estático',
    archived: 'Archivado',
    scans: 'Escaneos',
    clicks: 'Clics',
    open: 'Abrir en CodeQR',
    seeScans: 'Ver escaneos',
    seeClicks: 'Ver clics',
    copy: 'Copiar',
    copied: 'Copiado',
    qrAlt: 'Código QR de {link}',
    askScans: '¿Cuántos escaneos tuvo {link} en los últimos 30 días?',
    askClicks: '¿Cuántos clics tuvo {link} en los últimos 30 días?',
    types: { text: 'Texto', phone: 'Teléfono', email: 'Correo', sms: 'SMS', wifi: 'Wi-Fi', vcard: 'Tarjeta de contacto', crypto: 'Cripto', whatsapp: 'WhatsApp' },
  },
  fr: {
    dynamic: 'Dynamique · la destination peut changer',
    static: 'Statique',
    archived: 'Archivé',
    scans: 'Scans',
    clicks: 'Clics',
    open: 'Ouvrir dans CodeQR',
    seeScans: 'Voir les scans',
    seeClicks: 'Voir les clics',
    copy: 'Copier',
    copied: 'Copié',
    qrAlt: 'QR code de {link}',
    askScans: 'Combien de scans {link} a-t-il eus ces 30 derniers jours ?',
    askClicks: 'Combien de clics {link} a-t-il eus ces 30 derniers jours ?',
    types: { text: 'Texte', phone: 'Téléphone', email: 'E-mail', sms: 'SMS', wifi: 'Wi-Fi', vcard: 'Fiche contact', crypto: 'Crypto', whatsapp: 'WhatsApp' },
  },
  de: {
    dynamic: 'Dynamisch · Ziel änderbar',
    static: 'Statisch',
    archived: 'Archiviert',
    scans: 'Scans',
    clicks: 'Klicks',
    open: 'In CodeQR öffnen',
    seeScans: 'Scans ansehen',
    seeClicks: 'Klicks ansehen',
    copy: 'Kopieren',
    copied: 'Kopiert',
    qrAlt: 'QR-Code für {link}',
    askScans: 'Wie viele Scans hatte {link} in den letzten 30 Tagen?',
    askClicks: 'Wie viele Klicks hatte {link} in den letzten 30 Tagen?',
    types: { text: 'Text', phone: 'Telefon', email: 'E-Mail', sms: 'SMS', wifi: 'WLAN', vcard: 'Kontaktkarte', crypto: 'Krypto', whatsapp: 'WhatsApp' },
  },
  it: {
    dynamic: 'Dinamico · la destinazione può cambiare',
    static: 'Statico',
    archived: 'Archiviato',
    scans: 'Scansioni',
    clicks: 'Clic',
    open: 'Apri in CodeQR',
    seeScans: 'Vedi scansioni',
    seeClicks: 'Vedi clic',
    copy: 'Copia',
    copied: 'Copiato',
    qrAlt: 'Codice QR di {link}',
    askScans: 'Quante scansioni ha avuto {link} negli ultimi 30 giorni?',
    askClicks: 'Quanti clic ha avuto {link} negli ultimi 30 giorni?',
    types: { text: 'Testo', phone: 'Telefono', email: 'E-mail', sms: 'SMS', wifi: 'Wi-Fi', vcard: 'Biglietto da visita', crypto: 'Cripto', whatsapp: 'WhatsApp' },
  },
  ru: {
    dynamic: 'Динамический · адрес можно изменить',
    static: 'Статический',
    archived: 'В архиве',
    scans: 'Сканирования',
    clicks: 'Переходы',
    open: 'Открыть в CodeQR',
    seeScans: 'Смотреть сканирования',
    seeClicks: 'Смотреть переходы',
    copy: 'Копировать',
    copied: 'Скопировано',
    qrAlt: 'QR-код для {link}',
    askScans: 'Сколько сканирований было у {link} за последние 30 дней?',
    askClicks: 'Сколько переходов было у {link} за последние 30 дней?',
    types: { text: 'Текст', phone: 'Телефон', email: 'Эл. почта', sms: 'SMS', wifi: 'Wi-Fi', vcard: 'Визитка', crypto: 'Крипто', whatsapp: 'WhatsApp' },
  },
  zh: {
    dynamic: '动态 · 目标地址可更改',
    static: '静态',
    archived: '已归档',
    scans: '扫描次数',
    clicks: '点击次数',
    open: '在 CodeQR 中打开',
    seeScans: '查看扫描',
    seeClicks: '查看点击',
    copy: '复制',
    copied: '已复制',
    qrAlt: '{link} 的二维码',
    askScans: '{link} 过去30天有多少次扫描？',
    askClicks: '{link} 过去30天有多少次点击？',
    types: { text: '文本', phone: '电话', email: '电子邮件', sms: '短信', wifi: 'Wi-Fi', vcard: '名片', crypto: '加密货币', whatsapp: 'WhatsApp' },
  },
  ja: {
    dynamic: 'ダイナミック · 遷移先を変更可能',
    static: 'スタティック',
    archived: 'アーカイブ済み',
    scans: 'スキャン数',
    clicks: 'クリック数',
    open: 'CodeQR で開く',
    seeScans: 'スキャン数を見る',
    seeClicks: 'クリック数を見る',
    copy: 'コピー',
    copied: 'コピーしました',
    qrAlt: '{link} の QR コード',
    askScans: '{link} の過去30日間のスキャン数は？',
    askClicks: '{link} の過去30日間のクリック数は？',
    types: { text: 'テキスト', phone: '電話', email: 'メール', sms: 'SMS', wifi: 'Wi-Fi', vcard: '連絡先', crypto: '暗号資産', whatsapp: 'WhatsApp' },
  },
  ko: {
    dynamic: '동적 · 목적지 변경 가능',
    static: '정적',
    archived: '보관됨',
    scans: '스캔 수',
    clicks: '클릭 수',
    open: 'CodeQR에서 열기',
    seeScans: '스캔 보기',
    seeClicks: '클릭 보기',
    copy: '복사',
    copied: '복사됨',
    qrAlt: '{link}의 QR 코드',
    askScans: '{link}의 최근 30일 스캔 수는?',
    askClicks: '{link}의 최근 30일 클릭 수는?',
    types: { text: '텍스트', phone: '전화', email: '이메일', sms: 'SMS', wifi: 'Wi-Fi', vcard: '연락처', crypto: '암호화폐', whatsapp: 'WhatsApp' },
  },
};

/** `pt` alone means Brazilian Portuguese, as in the app; other regional tags fall back to their language. */
export function resolveLocale(tag: string | null | undefined): Locale {
  const lower = (tag ?? '').trim().toLowerCase().replace('_', '-');
  if ((LOCALES as readonly string[]).includes(lower)) return lower as Locale;
  const language = lower.split('-')[0];
  if (language === 'pt') return 'pt-br';
  return (LOCALES as readonly string[]).includes(language) ? (language as Locale) : 'en';
}

export function stringsFor(locale: Locale): Strings {
  return STRINGS[locale];
}

export function fill(template: string, link: string): string {
  return template.replace('{link}', link);
}
