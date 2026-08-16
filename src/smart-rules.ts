/**
 * Structural checks for the `rules` argument, run before the call leaves here.
 *
 * The API is still the authority — it validates the same invariants and more
 * (URL parsing, plan gating, attribute values).
 *
 * What this buys is a round-trip and a readable sentence, not information that
 * was otherwise lost. An earlier version of this comment claimed the reason
 * never reached the caller; that was wrong. The API answers
 * `{error:{code,message,doc_url}}`, and because the SDK's `makeMessage` looks
 * for `error.message` at the top level and finds it nested, it falls through
 * to `JSON.stringify(error)` — so the caller already got
 * `422 {"error":{...,"message":"rules.0: Split weights must add up to 100"}}`.
 * Verified against the installed SDK, not read off the types.
 *
 * So the honest justification is smaller: one fewer failed call, and a message
 * addressed to whoever has to fix the payload — naming the rule by position,
 * saying what the weights add up to — instead of a serialized body behind a
 * status code.
 *
 * Only the invariants a caller can violate while writing plausible JSON are
 * checked here. Anything requiring knowledge this process does not have — is
 * the workspace on Business, is the URL reachable — stays with the API.
 *
 * Mirrors lib/zod/schemas/smart-rules.ts in the CodeQR repo. When the two
 * disagree, that file wins; this one exists to explain, not to decide.
 */

const MAX_RULES = 20;
const MIN_VARIANTS = 2;
const MAX_VARIANTS = 4;

type Rule = {
  attribute?: unknown;
  operator?: unknown;
  value?: unknown;
  url?: unknown;
  split?: unknown;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Returns a sentence describing the first problem, or null when the payload is
 * structurally sound.
 *
 * One problem at a time, earliest rule first: a model handed a list of six
 * violations tends to fix one and resend, and later messages are frequently
 * consequences of the first.
 */
export function validateSmartRules(rules: unknown): string | null {
  if (rules === undefined || rules === null) return null;

  if (!Array.isArray(rules)) {
    return 'rules must be an array of rule objects.';
  }

  if (rules.length > MAX_RULES) {
    return `rules takes at most ${MAX_RULES} rules, got ${rules.length}.`;
  }

  for (let i = 0; i < rules.length; i++) {
    const at = `rule ${i + 1}`;
    const rule = rules[i] as Rule;

    if (!isObject(rule)) {
      return `${at} must be an object.`;
    }

    const problem = checkRule(rule, at);
    if (problem) return problem;

    // An unconditional rule matches everything, so anything after it is dead
    // code. Caught here rather than left to the API because the symptom —
    // rules that silently never run — is invisible in the response.
    const unconditional = rule.attribute === undefined;
    if (unconditional && i !== rules.length - 1) {
      return `${at} has no condition, so it matches all traffic and must be the last rule. It is currently followed by ${rules.length - i - 1} rule(s) that would never run.`;
    }
  }

  return null;
}

function checkRule(rule: Rule, at: string): string | null {
  const hasUrl = rule.url !== undefined;
  const hasSplit = rule.split !== undefined;

  if (hasUrl && hasSplit) {
    return `${at} has both url and split. A rule sends traffic to one destination or divides it between several, never both.`;
  }

  if (!hasUrl && !hasSplit) {
    return `${at} has no destination. Give it a url, or a split of 2-4 variants.`;
  }

  const condition = [rule.attribute, rule.operator, rule.value];
  const present = condition.filter((p) => p !== undefined).length;
  if (present !== 0 && present !== 3) {
    return `${at} has an incomplete condition. A condition needs attribute, operator and value together, or none of the three.`;
  }

  if (present === 0 && !hasSplit) {
    return `${at} has no condition and no split. A rule without a condition matches all traffic, so it only makes sense when it divides that traffic.`;
  }

  return hasSplit ? checkSplit(rule.split, at) : null;
}

function checkSplit(split: unknown, at: string): string | null {
  if (!Array.isArray(split)) {
    return `${at}: split must be an array of variants.`;
  }

  if (split.length < MIN_VARIANTS) {
    return `${at}: split needs at least ${MIN_VARIANTS} variants, got ${split.length}.`;
  }

  if (split.length > MAX_VARIANTS) {
    return `${at}: split takes at most ${MAX_VARIANTS} variants, got ${split.length}.`;
  }

  let total = 0;

  for (let i = 0; i < split.length; i++) {
    const where = `${at}, variant ${i + 1}`;
    const variant = split[i] as { url?: unknown; weight?: unknown };

    if (!isObject(variant)) {
      return `${where} must be an object with url and weight.`;
    }

    if (typeof variant.url !== 'string' || variant.url === '') {
      return `${where} needs a url.`;
    }

    const { weight } = variant;

    if (typeof weight !== 'number' || Number.isNaN(weight)) {
      return `${where} needs a weight.`;
    }

    // Checked before the sum so that 50.5 + 49.5 reports the real mistake
    // instead of passing the total and failing somewhere less obvious.
    if (!Number.isInteger(weight)) {
      return `${where}: weight must be a whole number, got ${weight}.`;
    }

    if (weight < 1 || weight > 100) {
      return `${where}: weight must be between 1 and 100, got ${weight}.`;
    }

    total += weight;
  }

  if (total !== 100) {
    return `${at}: split weights must add up to 100, got ${total}.`;
  }

  return null;
}
