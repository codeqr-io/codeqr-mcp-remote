import { describe, expect, it } from 'vitest';
import { CODEQR_OAUTH_SCOPES } from '../src/config.js';
import { IMPLICIT_SCOPE, renderConsentPage, SCOPE_MESSAGES } from '../src/oauth/consent-page.js';
import { en, type MessageKey } from '../src/oauth/i18n/en.js';
import {
  CATALOGS,
  DEFAULT_LOCALE,
  LOCALES,
  negotiateLocale,
  PLACEHOLDER,
  translate,
} from '../src/oauth/i18n/index.js';
import { VERIFIED_CLIENTS } from '../src/oauth/verified-clients.js';

const KEYS = Object.keys(en) as MessageKey[];
const ALLOWED_TAGS = ['b', 'strong'];

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!).sort();
}

describe('negotiateLocale', () => {
  it.each([
    [undefined, 'en'],
    ['', 'en'],
    ['xx', 'en'],
    ['*', 'en'],
    ['pt-BR,pt;q=0.9', 'pt-br'],
    ['pt', 'pt-br'],
    ['pt-AO', 'pt-br'],
    ['pt-PT', 'pt-pt'],
    ['pt-pt;q=0.8, en;q=0.5', 'pt-pt'],
    ['zh', 'zh'],
    ['zh-TW', 'zh'],
    ['zh-Hant-HK', 'zh'],
    ['ja', 'ja'],
    ['ja-JP', 'ja'],
    ['ko-KR', 'ko'],
    ['es-MX', 'es'],
    ['fr-CA', 'fr'],
    ['de-AT', 'de'],
    ['ru-RU', 'ru'],
    ['it-CH', 'it'],
    ['en-GB', 'en'],
    ['EN-us', 'en'],
  ])('%s → %s', (header, locale) => {
    expect(negotiateLocale(header)).toBe(locale);
  });

  it('ranks by q-value, not by position', () => {
    expect(negotiateLocale('en;q=0.5, fr;q=0.9')).toBe('fr');
    expect(negotiateLocale('it;q=0.1, ko')).toBe('ko');
  });

  it('keeps the header order between equal q-values', () => {
    expect(negotiateLocale('de, fr')).toBe('de');
    expect(negotiateLocale('fr;q=0.7, de;q=0.7')).toBe('fr');
  });

  it('skips ranges it cannot serve and takes the next one', () => {
    expect(negotiateLocale('xx, nl;q=0.9, ko;q=0.8')).toBe('ko');
  });

  it('treats q=0 as refused and drops a malformed q', () => {
    expect(negotiateLocale('ja;q=0, it')).toBe('it');
    expect(negotiateLocale('ja;q=abc, de;q=0.5')).toBe('de');
    expect(negotiateLocale('ja;q=2, es;q=0.1')).toBe('es');
    expect(negotiateLocale('ja;q=, ko;q=0.3')).toBe('ko');
  });
});

describe('message catalogs', () => {
  it('cover exactly the app locales, the default among them', () => {
    expect(LOCALES.length).toBeGreaterThan(0);
    expect(Object.keys(CATALOGS).sort()).toEqual([...LOCALES].sort());
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });

  it('have every message, non-empty, in every locale', () => {
    expect(KEYS.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      expect(Object.keys(CATALOGS[locale]).sort()).toEqual([...KEYS].sort());
      for (const key of KEYS) expect(CATALOGS[locale][key].trim(), `${locale} ${key}`).not.toBe('');
    }
  });

  it('use the same placeholders as English', () => {
    for (const locale of LOCALES) {
      for (const key of KEYS) {
        expect(placeholders(CATALOGS[locale][key]), `${locale} ${key}`).toEqual(placeholders(en[key]));
      }
    }
  });

  it('carry no markup but balanced <b> and <strong>, and nothing else to escape', () => {
    for (const locale of LOCALES) {
      for (const key of KEYS) {
        const text = CATALOGS[locale][key];
        for (const tag of ALLOWED_TAGS) {
          expect(text.split(`<${tag}>`).length, `${locale} ${key} <${tag}>`).toBe(text.split(`</${tag}>`).length);
        }
        const bare = text.replace(new RegExp(`</?(?:${ALLOWED_TAGS.join('|')})>`, 'g'), '');
        expect(bare, `${locale} ${key}`).not.toMatch(/[<>&"]/);
      }
    }
  });

  it('are translated, not copied from English', () => {
    for (const locale of LOCALES.filter((l) => l !== 'en')) {
      for (const key of KEYS) expect(CATALOGS[locale][key], `${locale} ${key}`).not.toBe(en[key]);
    }
  });

  it('fill placeholders and leave a missing one visible', () => {
    expect(translate('en', 'consent.nextReturnVerified', { client: 'ChatGPT' })).toBe('You return to ChatGPT.');
    expect(translate('en', 'consent.nextReturnVerified')).toContain('{client}');
  });
});

describe('consent page in every locale', () => {
  const verifiedRedirect = Object.keys(VERIFIED_CLIENTS)[0]!;
  const page = (locale: (typeof LOCALES)[number], redirectUri = 'https://acme.test/cb') =>
    renderConsentPage({ clientName: 'Acme', redirectUri, scopes: CODEQR_OAUTH_SCOPES, locale, fields: {} });

  it('has a description for every scope it can list', () => {
    const listed = [...CODEQR_OAUTH_SCOPES, IMPLICIT_SCOPE];
    expect(listed.length).toBeGreaterThan(1);
    for (const scope of listed) expect(Object.hasOwn(SCOPE_MESSAGES, scope), scope).toBe(true);
  });

  it('sets lang and renders its strings from that locale', () => {
    for (const locale of LOCALES) {
      const html = page(locale);
      expect(html).toContain(`<html lang="${locale}">`);
      for (const key of [
        'consent.pageTitle',
        'consent.unverified',
        'consent.destinationLabel',
        'consent.permissionsLabel',
        'consent.scope.linksWrite',
        'consent.scope.userRead',
        'consent.nextTitle',
        'consent.nextSignIn',
        'consent.nextProject',
        'consent.nextReturnGeneric',
        'consent.refuse',
        'consent.continue',
        'consent.privacy',
        'consent.terms',
      ] as const) {
        expect(html, `${locale} ${key}`).toContain(translate(locale, key));
      }
    }
  });

  it('names a verified client in the last step, and only a generic app otherwise', () => {
    for (const locale of LOCALES) {
      const verified = page(locale, verifiedRedirect);
      const name = VERIFIED_CLIENTS[verifiedRedirect]!.name;
      expect(verified).toContain(translate(locale, 'consent.nextReturnVerified', { client: name }));
      expect(verified).toContain(translate(locale, 'consent.verified'));
      expect(verified).not.toContain(translate(locale, 'consent.nextReturnGeneric'));

      const unverified = page(locale);
      expect(unverified).not.toContain(translate(locale, 'consent.nextReturnVerified', { client: 'Acme' }));
    }
  });

  it('describes loopback and app-scheme destinations in the page language', () => {
    expect(page('es', 'http://localhost:6274/cb')).toContain(translate('es', 'consent.destinationLoopback'));
    expect(page('ko', 'cursor://anysphere.cursor-retrieval/cb')).toContain(translate('ko', 'consent.destinationApp'));
  });
});
