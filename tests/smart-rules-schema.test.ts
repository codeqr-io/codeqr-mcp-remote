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

const schemaOf = (tool: string) =>
  (TOOLS.find((t) => t.name === tool)?.inputSchema.properties as Record<string, any>)?.rules;

const rule = () => schemaOf('create_link').items.properties;

/**
 * The twelve of SMART_RULE_ATTRIBUTES in the CodeQR repo, each dispatched by
 * name in match-smart-rule.ts. Duplicated as a literal because the two repos
 * do not share a module: when they drift, this list is the thing that has to
 * be updated deliberately.
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

describe('value description names what the request actually carries', () => {
  const value = () => rule().value.description as string;

  // device is compared against ctx.ua.os?.name — never a form factor.
  it('gives the operating-system values for device', () => {
    for (const os of ['iOS', 'Android', 'Windows', 'Mac OS', 'Linux']) {
      expect(value()).toContain(os);
    }
  });

  it('warns off "mobile", the guess that silently matches nothing', () => {
    expect(value()).toMatch(/never "mobile"|not "mobile"|never "mobile" or "desktop"/);
  });

  it('says language is a two-letter code and referrer a bare domain', () => {
    expect(value()).toMatch(/two-letter/i);
    expect(value()).toMatch(/bare domain|domain, such as/i);
  });

  it('says the comparison is whole-value, not a substring', () => {
    expect(value()).toMatch(/whole/i);
    expect(value()).toMatch(/substring/i);
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
