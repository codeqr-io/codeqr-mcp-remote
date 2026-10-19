/**
 * The languages this server's own pages speak, chosen from Accept-Language.
 *
 * Same locales as the CodeQR app, whose i18n/config.ts is the source of truth;
 * this repo cannot import it, so the list is repeated here.
 */

import type { Request } from 'express';
import { de } from './de.js';
import { en, type MessageKey, type Messages } from './en.js';
import { es } from './es.js';
import { fr } from './fr.js';
import { it } from './it.js';
import { ja } from './ja.js';
import { ko } from './ko.js';
import { ptBr } from './pt-br.js';
import { ptPt } from './pt-pt.js';
import { ru } from './ru.js';
import { zh } from './zh.js';

export type { MessageKey, Messages } from './en.js';

export const LOCALES = ['pt-br', 'pt-pt', 'en', 'es', 'fr', 'de', 'zh', 'ru', 'it', 'ja', 'ko'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const CATALOGS: Record<Locale, Messages> = {
  'pt-br': ptBr,
  'pt-pt': ptPt,
  en,
  es,
  fr,
  de,
  zh,
  ru,
  it,
  ja,
  ko,
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** The best supported locale for an Accept-Language header, by q-value and then by order. */
export function negotiateLocale(acceptLanguage: string | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const ranges = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.split(';');
      let q = 1;
      for (const param of params) {
        const [name, value] = param.split('=');
        if (name?.trim().toLowerCase() === 'q') q = value?.trim() ? Number(value) : Number.NaN;
      }
      return { tag: tag.trim().toLowerCase(), q, index };
    })
    .filter(({ tag, q }) => tag !== '' && tag !== '*' && q > 0 && q <= 1)
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const { tag } of ranges) {
    const locale = matchLocale(tag);
    if (locale) return locale;
  }

  return DEFAULT_LOCALE;
}

export function resolveLocale(req: Pick<Request, 'get'>): Locale {
  return negotiateLocale(req.get('accept-language'));
}

/** `{name}` placeholders are filled verbatim; see en.ts for what that asks of an HTML caller. */
export function translate(locale: Locale, key: MessageKey, values: Readonly<Record<string, string>> = {}): string {
  return CATALOGS[locale][key].replace(PLACEHOLDER, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? values[name]! : placeholder,
  );
}

export const PLACEHOLDER = /\{(\w+)\}/g;

// Portuguese without a region, and every region but Portugal, gets the
// Brazilian catalog, as a bare `pt` does in the app. Any other language falls
// back from its regional tag (es-MX, zh-TW, en-GB) to the language itself.
function matchLocale(tag: string): Locale | null {
  if (isLocale(tag)) return tag;

  const primary = tag.split('-')[0] ?? '';
  if (primary === 'pt') return 'pt-br';
  return isLocale(primary) ? primary : null;
}
