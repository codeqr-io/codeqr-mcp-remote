/** The CodeQR app's locales; a widget picks its labels by the language the host reports. */

export const LOCALES = ['pt-br', 'pt-pt', 'en', 'es', 'fr', 'de', 'zh', 'ru', 'it', 'ja', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];

/** `pt` alone means Brazilian Portuguese, as in the app; other regional tags fall back to their language. */
export function resolveLocale(tag: string | null | undefined): Locale {
  const lower = (tag ?? '').trim().toLowerCase().replace('_', '-');
  if ((LOCALES as readonly string[]).includes(lower)) return lower as Locale;
  const language = lower.split('-')[0];
  if (language === 'pt') return 'pt-br';
  return (LOCALES as readonly string[]).includes(language) ? (language as Locale) : 'en';
}
