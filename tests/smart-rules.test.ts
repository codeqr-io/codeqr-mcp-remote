/**
 * The MCP does not re-implement the API's validation — the API stays the
 * authority. What it does is turn the five structural invariants into a
 * sentence addressed to whoever has to fix the payload, and save the failed
 * round-trip. It does not rescue a lost message: the API's reason does reach
 * the caller today, serialized inside the SDK's error string. See the comment
 * in src/smart-rules.ts.
 *
 * Each case here is a mistake an agent actually makes when handed the schema:
 * both destinations at once, a half-written condition, weights that look like
 * percentages but do not add up, an unconditional rule left in the middle.
 *
 * Fixtures use values the middleware can actually match, so that nothing here
 * doubles as an example of how to write a rule. A structurally valid rule that
 * never matches is the failure this feature is most likely to ship.
 */

import { describe, it, expect } from 'vitest';
import { validateSmartRules } from '../src/smart-rules.js';

const split = (a: number, b: number) => [
  { url: 'https://example.com/a', weight: a },
  { url: 'https://example.com/b', weight: b },
];

describe('validateSmartRules', () => {
  it('accepts an unconditional split — the A/B case', () => {
    expect(validateSmartRules([{ split: split(50, 50) }])).toBeNull();
  });

  it('accepts a condition routing to a single url, with a split last', () => {
    expect(
      validateSmartRules([
        { attribute: 'device', operator: 'equals', value: 'iOS', url: 'https://example.com/m' },
        { split: split(30, 70) },
      ]),
    ).toBeNull();
  });

  it('accepts nothing at all — rules is optional', () => {
    expect(validateSmartRules(undefined)).toBeNull();
    expect(validateSmartRules(null)).toBeNull();
  });

  it('rejects url and split on the same rule', () => {
    const msg = validateSmartRules([{ url: 'https://example.com/x', split: split(50, 50) }]);
    expect(msg).toMatch(/rule 1/i);
    expect(msg).toMatch(/never both/i);
  });

  it('rejects a rule with neither destination', () => {
    const msg = validateSmartRules([{ attribute: 'device', operator: 'equals', value: 'iOS' }]);
    expect(msg).toMatch(/rule 1/i);
    expect(msg).toMatch(/url.*or.*split/i);
  });

  it('rejects a half-written condition', () => {
    const msg = validateSmartRules([
      { attribute: 'device', url: 'https://example.com/m' },
      { split: split(50, 50) },
    ]);
    expect(msg).toMatch(/attribute, operator and value/i);
  });

  it('rejects a conditionless rule that does not split', () => {
    const msg = validateSmartRules([{ url: 'https://example.com/x' }]);
    expect(msg).toMatch(/without a condition/i);
  });

  // The one the model gets wrong most often: weights that read as percentages
  // of something else, or two variants at 50 plus a third at 50.
  it('rejects weights that do not add up to 100, and says what they add up to', () => {
    const msg = validateSmartRules([{ split: split(30, 30) }]);
    expect(msg).toMatch(/100/);
    expect(msg).toMatch(/60/);
  });

  it('rejects fewer than 2 or more than 4 variants', () => {
    expect(validateSmartRules([{ split: [{ url: 'https://example.com/a', weight: 100 }] }])).toMatch(
      /at least 2/i,
    );
    const five = Array.from({ length: 5 }, (_, i) => ({
      url: `https://example.com/${i}`,
      weight: 20,
    }));
    expect(validateSmartRules([{ split: five }])).toMatch(/at most 4/i);
  });

  it('rejects a non-integer or out-of-range weight before the sum is even checked', () => {
    expect(validateSmartRules([{ split: split(50.5, 49.5) }])).toMatch(/whole number/i);
    expect(validateSmartRules([{ split: [...split(100, 0)] }])).toMatch(/between 1 and 100/i);
  });

  it('rejects an unconditional rule that is not last, naming the position', () => {
    const msg = validateSmartRules([
      { split: split(50, 50) },
      { attribute: 'device', operator: 'equals', value: 'iOS', url: 'https://example.com/m' },
    ]);
    expect(msg).toMatch(/rule 1/i);
    expect(msg).toMatch(/matches all traffic/i);
  });

  it('rejects more than 20 rules', () => {
    const many = Array.from({ length: 21 }, () => ({
      attribute: 'device',
      operator: 'equals',
      value: 'iOS',
      url: 'https://example.com/m',
    }));
    expect(validateSmartRules(many)).toMatch(/at most 20/i);
  });

  it('rejects a rules value that is not an array', () => {
    expect(validateSmartRules({ split: split(50, 50) })).toMatch(/array/i);
  });

  /**
   * Reporting only the first problem is deliberate. A list of every violation
   * reads as a wall to a model that is going to retry anyway, and the second
   * message is often a consequence of the first — an unparsable split reports
   * both "not an integer" and "does not add up to 100".
   */
  it('reports one problem at a time, the earliest rule first', () => {
    const msg = validateSmartRules([
      { url: 'https://example.com/x', split: split(50, 50) },
      { split: split(10, 10) },
    ]);
    expect(msg).toMatch(/rule 1/i);
    expect(msg).not.toMatch(/rule 2/i);
  });
});
