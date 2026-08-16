/**
 * The `rules` schema as a claim about the CodeQR middleware.
 *
 * Everything here failed at least once in review. The dangerous mistakes in
 * this field are not rejected calls — they are calls the API accepts and the
 * middleware then never matches, which looks like "the A/B test got no
 * traffic" and has no error anywhere to trace back from.
 */

import { describe, it, expect } from 'vitest';
import { TOOLS, SERVER_INSTRUCTIONS } from '../src/routes/mcp.js';
import { ATTRIBUTE_VALUE_HINTS } from '../src/smart-rules.js';

const schemaOf = (tool: string) =>
  (TOOLS.find((t) => t.name === tool)?.inputSchema.properties as Record<string, any>)?.rules;

const rule = () => schemaOf('create_link').items.properties;

/**
 * The twelve of SMART_RULE_ATTRIBUTES in the CodeQR repo, each dispatched by
 * name in match-smart-rule.ts. Duplicated as a literal because the two repos
 * do not share a module.
 *
 * Known limit, so nobody mistakes this for more than it is: it catches this
 * repo drifting from the list, and is blind to the CodeQR repo adding a
 * thirteenth attribute — nothing here would fail. Closing that needs a marker
 * on the other side; tracked as a separate story.
 */
const API_ATTRIBUTES = [
  'device',
  'country',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'referrer',
  'language',
  'city',
  'region',
  'continent',
  'utm_term',
  'utm_content',
];

describe('attribute inventory', () => {
  it('offers every attribute the middleware implements', () => {
    // Advertising seven of twelve is not a safe subset: the five left out are
    // implemented, offered by the UI, and simply unreachable from an agent.
    expect(rule().attribute.enum).toEqual(API_ATTRIBUTES);
  });

  it('is mirrored by both tools', () => {
    expect(schemaOf('update_link').items.properties.attribute.enum).toEqual(API_ATTRIBUTES);
  });
});

/**
 * These assert on values, not on adjectives.
 *
 * The previous version checked that the description contained the word
 * "whole" and the phrase "bare domain" — and passed while that same
 * description told callers that `region` takes names like "São Paulo".
 * `region` is `geo.countryRegion`, an ISO 3166-2 code, so every rule written
 * from that sentence would have saved and never matched. A test that reads
 * the prose for vocabulary cannot catch a wrong value stated fluently.
 *
 * So each case below names one attribute and the value the middleware really
 * compares, sourced from the CodeQR repo:
 *
 *   device    ctx.ua.os?.name                   match-smart-rule.ts:33
 *   region    geo.countryRegion (ISO 3166-2)    resolve-visitor-geo.ts:16
 *   language  only i18n/config locales          resolve-visitor-language.ts:13
 *   referrer  bare domain                       build-match-context.ts:49
 */
describe('value hints name what the middleware actually compares', () => {
  it('covers every attribute the tool offers, with no extras', () => {
    expect(Object.keys(ATTRIBUTE_VALUE_HINTS).sort()).toEqual([...API_ATTRIBUTES].sort());
  });

  it('device is an OS name, and the form-factor guess is called out', () => {
    const hint = ATTRIBUTE_VALUE_HINTS.device;
    for (const os of ['iOS', 'Android', 'Windows', 'Mac OS', 'Linux']) {
      expect(hint).toContain(os);
    }
    expect(hint).toMatch(/never "mobile"/i);
  });

  it('region is the ISO 3166-2 code, never the state name', () => {
    const hint = ATTRIBUTE_VALUE_HINTS.region;
    expect(hint).toContain('3166-2');
    expect(hint).toMatch(/never the state name|not the state name/i);
    // The trap this test exists for: "São Paulo" is right for city and wrong
    // for region, and both once appeared in the same sentence.
    expect(hint).not.toContain('São Paulo');
  });

  it('city is the name, and keeps the example region must not have', () => {
    expect(ATTRIBUTE_VALUE_HINTS.city).toContain('São Paulo');
  });

  it('language lists the locales that can match, not "any two-letter code"', () => {
    // resolveVisitorLanguage returns null for anything outside i18n/config,
    // so "nl" is a valid ISO code that matches nothing here.
    const hint = ATTRIBUTE_VALUE_HINTS.language;
    for (const locale of ['pt', 'en', 'es', 'fr', 'de', 'zh', 'ru', 'it', 'ja', 'ko']) {
      expect(hint).toMatch(new RegExp(`\\b${locale}\\b`));
    }
    expect(hint).not.toMatch(/any two-letter/i);
  });

  it('referrer is a bare domain', () => {
    expect(ATTRIBUTE_VALUE_HINTS.referrer).toContain('google.com');
    expect(ATTRIBUTE_VALUE_HINTS.referrer).toMatch(/never a full URL/i);
  });

  it('ships every hint in the description the model reads', () => {
    // The generated sentence is the only copy a client ever sees; if the table
    // and the schema drift, the table is the one nobody looks at.
    const description = rule().value.description as string;
    for (const [attribute, hint] of Object.entries(ATTRIBUTE_VALUE_HINTS)) {
      expect(description, attribute).toContain(hint);
    }
  });

  it('says a wrong value fails silently rather than erroring', () => {
    expect(rule().value.description).toMatch(/never matches|not an error/i);
  });
});

describe('ending a test', () => {
  it('accepts null, which is how every rule is removed', () => {
    // The API takes null (`rules` is nullish). A schema of `type: 'array'`
    // alone has a validating client reject the only value that clears them.
    for (const tool of ['create_link', 'update_link']) {
      expect(schemaOf(tool).type, tool).toContain('null');
    }
  });

  it('says so in the description, since null is not a guessable affordance', () => {
    expect(schemaOf('create_link').description).toMatch(/null/);
  });
});

describe('instructions do not outrun the middleware', () => {
  it('qualifies variant stability with the window it actually has', () => {
    // "keeps the same variant across visits" with no qualifier read as
    // permanent; without trackConversion the cookie lasts one hour.
    expect(SERVER_INSTRUCTIONS).toMatch(/hour/);
    expect(SERVER_INSTRUCTIONS).toMatch(/30 days/);
    expect(SERVER_INSTRUCTIONS).toMatch(/trackConversion/);
  });
});
