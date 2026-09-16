/**
 * What a plan gate is allowed to say to an MCP client.
 *
 * The CodeQR API answers a gate with sales copy — "Upgrade to Starter to use
 * this feature" — and the SDK puts the whole serialized body into
 * `Error.message`, so relaying it verbatim ships a plan name, and sometimes a
 * price, into the app. The directory forbids that; explaining the limit and
 * linking out does not. These tests pin both halves: the rewrite happens, and
 * everything that is not a plan gate is still passed through untouched.
 *
 * The messages quoted below are copied from the CodeQR repo, not invented —
 * `lib/api/links/process-link.ts`, `lib/analytics/utils.ts`,
 * `lib/shared-domains.ts` and `exceededLimitError` in `lib/api/errors.ts`.
 */

import { describe, it, expect } from 'vitest';
import { toClientFacingError, HELP_URL } from '../src/plan-limit-message.js';
import { handleToolCall, SERVER_INSTRUCTIONS, TOOLS } from '../src/routes/mcp.js';

/**
 * An error shaped the way `@codeqr/ts` builds one.
 *
 * `APIError.makeMessage` finds no `message` at the top level of the body, so
 * it falls back to `JSON.stringify(body)` — which is why the raw text carries
 * the sales copy and the code at once. Reproduced here rather than imported so
 * the test fails when the rewrite stops working, not when the SDK is absent.
 */
function apiError(status: number, code: string, message: string) {
  const body = { error: { code, message, doc_url: 'https://codeqr.io/docs/api-reference' } };
  return Object.assign(new Error(`${status} ${JSON.stringify(body)}`), {
    status,
    error: body,
  });
}

/** Applied to the whole message, link included — the URL is text the user sees. */
const FORBIDDEN = /upgrade|\bplans?\b|\bstarter\b|\bpro\b|\bbusiness\b|\$\d/i;

const PLAN_GATES = [
  'You can only use the Flexible Link feature on a Starter plan and above. Upgrade to Starter to use this feature.',
  'Smart rules are available on the Business plan and above. Upgrade to Business to use this feature.',
  'You can only use conversion tracking on a Pro plan and above. Upgrade to Pro to use this feature.',
  'You can only use link cloaking on a Pro plan and above. Upgrade to Pro to use this feature.',
  'You can only use pre-redirection on a Business plan and above. Upgrade to Business to use this feature.',
  'You can only set a redirect for a root domain link on a Pro plan and above. Upgrade to Pro to use this feature.',
  'This is a premium key. You can only use this key on a Starter plan. Upgrade to Starter to register this key.',
  'You can only get analytics for up to 30 days on a free plan. Upgrade to Starter, Pro, or Business to get analytics for longer periods.',
  'The domain example.sh is only available on paid plans. Use zipgo.ink or upgrade.',
];

/**
 * Built by `exceededLimitError` in `lib/api/errors.ts`. Every one of these
 * reaches the client as `forbidden`, except tags and folders — see the first
 * test in "a usage limit".
 */
const USAGE_LIMITS = [
  'You have reached the monthly limit of 25 links on the Free plan. Please upgrade to add more links.',
  'You have reached the monthly limit of 10 qrcodes on the Free plan. Please upgrade to add more QR Codes.',
  'You have reached the limit of 5 tags on the Free plan. Please upgrade to add more tags.',
  'You have reached the limit of 3 domains on the Free plan. Please upgrade to add more domains.',
  'You have reached the limit of 1000 scans on the Free plan. Please upgrade to add more scans.',
  'You have reached the limit of 1000 clicks on the Free plan. Please upgrade to add more clicks.',
  'You have reached the monthly limit of 1 folder on the Free plan. Please upgrade to add more folders.',
];

describe('a plan gate', () => {
  it('drops the sales copy the API sent and links out instead', () => {
    const { message, isPlanLimit } = toClientFacingError(
      apiError(403, 'forbidden', PLAN_GATES[0]),
    );

    expect(message).not.toMatch(/upgrade/i);
    expect(message).not.toMatch(/starter/i);
    expect(message).toContain(HELP_URL);
    expect(isPlanLimit).toBe(true);
  });

  it('names the feature, so the answer is not just "no"', () => {
    const smartRules = toClientFacingError(apiError(403, 'forbidden', PLAN_GATES[1])).message;
    const cloaking = toClientFacingError(apiError(403, 'forbidden', PLAN_GATES[3])).message;

    expect(smartRules).toMatch(/smart rules/i);
    expect(cloaking).toMatch(/cloaking/i);
    expect(smartRules).not.toEqual(cloaking);
  });

  it('tells the agent what to do about an analytics window', () => {
    // The one gate with a cheap way out: ask for less time. Saying so turns a
    // dead end into a retry the model can make without the user.
    const { message } = toClientFacingError(apiError(403, 'forbidden', PLAN_GATES[7]));

    expect(message).toMatch(/shorter/i);
  });

  it('is recognised by its wording even when the code is not forbidden', () => {
    // `lib/shared-domains.ts` raises this one as a 422.
    const { message, isPlanLimit } = toClientFacingError(
      apiError(422, 'unprocessable_entity', PLAN_GATES[8]),
    );

    expect(isPlanLimit).toBe(true);
    expect(message).not.toMatch(/upgrade/i);
    expect(message).toMatch(/domain/i);
  });
});

describe('a usage limit', () => {
  it('is recognised by its wording, because the code is not exceeded_limit', () => {
    // The quotas this server can reach — links, QR codes, clicks, scans — are
    // all raised as `forbidden` (`lib/exceeded.ts`,
    // `lib/api/links/usage-checks.ts`, `lib/api/qrcodes/usage-checks.ts`).
    // Only tags, folders, users and projects use `exceeded_limit`, so keying
    // on the code recognised the four rare cases and missed the four common
    // ones.
    for (const raw of USAGE_LIMITS) {
      const asForbidden = toClientFacingError(apiError(403, 'forbidden', raw));
      const asExceeded = toClientFacingError(apiError(403, 'exceeded_limit', raw));

      expect(asForbidden.message, raw).toMatch(/billing cycle/);
      expect(asForbidden.message, raw).toEqual(asExceeded.message);
    }
  });

  it('says which allowance ran out and that it resets', () => {
    const links = toClientFacingError(apiError(403, 'forbidden', USAGE_LIMITS[0]));
    const qrcodes = toClientFacingError(apiError(403, 'forbidden', USAGE_LIMITS[1]));

    expect(links.message).toMatch(/short links/i);
    expect(links.message).toMatch(/resets/i);
    expect(qrcodes.message).toMatch(/QR codes/i);
    expect(links.isPlanLimit).toBe(true);
  });

  it('quotes the ceiling the API reported', () => {
    // The M3 gate asks for the number, and D-007 does not forbid it: a custom
    // limit is a per-workspace grant and a trial moves the reading, so the
    // ceiling does not name the tier.
    expect(toClientFacingError(apiError(403, 'forbidden', USAGE_LIMITS[0])).message).toMatch(
      /\b25 short links\b/,
    );
    expect(toClientFacingError(apiError(403, 'forbidden', USAGE_LIMITS[6])).message).toMatch(
      /\b1 folder\b/,
    );
  });

  it('reports a scan or click ceiling as metering, not as a creation limit', () => {
    const scans = toClientFacingError(apiError(403, 'forbidden', USAGE_LIMITS[4]));

    expect(scans.message).toMatch(/QR code scans/);
    expect(scans.message).not.toMatch(/short links/);
  });
});

describe('everything that is not a plan gate', () => {
  it('passes a rate limit through untouched', () => {
    // A 429 is about request pacing, not about what the workspace bought.
    const error = apiError(429, 'rate_limit_exceeded', 'Too many requests. Please try again later.');
    const { message, isPlanLimit } = toClientFacingError(error);

    expect(message).toBe(error.message);
    expect(isPlanLimit).toBe(false);
  });

  it('passes a not_found through untouched', () => {
    const error = apiError(404, 'not_found', 'Link not found.');
    const { message, isPlanLimit } = toClientFacingError(error);

    expect(message).toBe(error.message);
    expect(isPlanLimit).toBe(false);
  });

  it('passes a plain Error through untouched', () => {
    const { message, isPlanLimit } = toClientFacingError(new Error('Connection error.'));

    expect(message).toBe('Connection error.');
    expect(isPlanLimit).toBe(false);
  });

  it('survives something that is not an Error at all', () => {
    expect(toClientFacingError('boom').message).toBe('boom');
  });
});

describe('no rewritten message', () => {
  it('names a plan, a price, or an upgrade — for any gate the API can raise', () => {
    for (const raw of [...PLAN_GATES, ...USAGE_LIMITS]) {
      for (const code of ['forbidden', 'exceeded_limit', 'unprocessable_entity', 'bad_request']) {
        const { message, isPlanLimit } = toClientFacingError(apiError(403, code, raw));

        expect(isPlanLimit, raw).toBe(true);
        expect(message, `${code}: ${raw}`).not.toMatch(FORBIDDEN);
        expect(message, raw).toContain(HELP_URL);
      }
    }
  });
});

describe('the help link', () => {
  it('carries the attribution the campaign expects, and is not the pricing page', () => {
    expect(HELP_URL).toContain('utm_source=integration');
    expect(HELP_URL).toContain('utm_medium=mcp');
    expect(HELP_URL).toContain('utm_campaign=codeqr-mcp');
    expect(HELP_URL).toContain('utm_content=limit-reached');
    expect(HELP_URL).not.toContain('/pricing');
    expect(HELP_URL).not.toMatch(FORBIDDEN);
  });
});

describe('the text a client renders verbatim', () => {
  /**
   * The instructions and the schema descriptions are shown to, or repeated to,
   * the end user — so the rewrite at the error boundary buys nothing if a tier
   * list is sitting in a parameter description, which is where one was.
   *
   * What this covers is exactly the three things the rule turns on: a tier
   * name, a sell verb, a price. It deliberately does not ban the bare word
   * "plan" — "on plans that include it" states a fact without naming or
   * selling one — so it is not a proof that the text is neutral, only that it
   * has not drifted back to naming tiers.
   */
  const TIERS =
    /\bupgrade\b|\bsubscribe\b|\bstarter\b|\bbusiness\b|\benterprise\b|\bpro plan\b|\bfree plan\b|\$\d/i;

  it('does not name a tier in the server instructions', () => {
    expect(SERVER_INSTRUCTIONS.match(TIERS)?.[0]).toBeUndefined();
  });

  it('does not name a tier in any tool or parameter description', () => {
    expect(JSON.stringify(TOOLS).match(TIERS)?.[0]).toBeUndefined();
  });
});

describe('the tool call site', () => {
  /**
   * The unit tests above would keep passing if `handleToolCall` never called
   * the module — the same trap `smart-rules-call-site.test.ts` exists for.
   * Every tool shares one catch block, so one tool proves the wiring.
   */
  const throwingClient = (error: unknown) => ({
    links: {
      create: () => Promise.reject(error),
    },
  });

  it('rewrites what the client sees, rather than relaying the API text', async () => {
    const res = await handleToolCall(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throwingClient(apiError(403, 'forbidden', PLAN_GATES[1])) as any,
      'key',
      'create_link',
      { url: 'https://example.com' },
    );

    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toMatch(/upgrade/i);
    expect(res.content[0].text).not.toMatch(/business/i);
    expect(res.content[0].text).toContain(HELP_URL);
  });

  it('still relays an ordinary failure as it always did', async () => {
    const error = apiError(404, 'not_found', 'Link not found.');
    const res = await handleToolCall(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throwingClient(error) as any,
      'key',
      'create_link',
      { url: 'https://example.com' },
    );

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(`Error: ${error.message}`);
  });
});
