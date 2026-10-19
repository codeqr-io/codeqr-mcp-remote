/**
 * list_domains through the real `@codeqr/ts` client with only `fetch` faked, so
 * every error here is the one the SDK builds from the response.
 *
 * The tool has to behave in both worlds: before the API serves GET /domains,
 * the host answers with its HTML 404 page; after, the route answers with a
 * list that may be empty.
 */

import { readFileSync } from 'node:fs';
import Codeqr from '@codeqr/ts';
import { describe, expect, it } from 'vitest';
import { DOMAINS_MAX_PAGE_SIZE, NO_CUSTOM_DOMAINS_NOTE, TAGS_MAX_PAGE_SIZE } from '../src/list-tools.js';
import { LIMIT_DETAILS_URL } from '../src/plan-limit-message.js';
import { handleToolCall, TOOLS, type ToolOutcome } from '../src/routes/mcp.js';

// Trimmed from the page api.codeqr.io/domains served while the route did not
// exist. Its plan and domain words are what made it read as a plan gate.
const NOT_FOUND_PAGE = readFileSync(new URL('./fixtures/api-404-page.html', import.meta.url), 'utf8');

const PLAN_WORDS = /upgrade|\bplans?\b|\bstarter\b|\bpro\b|\bbusiness\b|\$\d/i;

// The shared-domain gate of lib/shared-domains.ts in the CodeQR repo.
const DOMAIN_GATE = 'The domain example.sh is only available on paid plans. Use zipgo.ink or upgrade.';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function call(respond: () => Response, name: string, args: Record<string, unknown> = {}) {
  const requests: URL[] = [];
  const client = new Codeqr({
    apiKey: 'key',
    baseURL: 'https://api.codeqr.test',
    maxRetries: 0,
    fetch: async (input: string | URL | Request) => {
      requests.push(new URL(input instanceof Request ? input.url : input));
      return respond();
    },
  });

  let outcome: ToolOutcome | undefined;
  const result = await handleToolCall(client, 'key', name, args, (ended) => {
    outcome = ended;
  });
  return { result, outcome, requests, text: result.content.map((c) => c.text).join('\n') };
}

describe('list_domains while the API has no GET /domains', () => {
  const notFound = () =>
    new Response(NOT_FOUND_PAGE, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });

  it('uses a page that still carries the words that made it read as a plan gate', () => {
    // Without them the next test would pass for the wrong reason.
    expect(NOT_FOUND_PAGE).toMatch(PLAN_WORDS);
    expect(NOT_FOUND_PAGE).toMatch(/\bdomains?\b/i);
  });

  it('is an API error with a neutral sentence, not a plan gate pointing back at list_domains', async () => {
    const { result, outcome, text } = await call(notFound, 'list_domains');

    expect(result.isError).toBe(true);
    expect(outcome).toBe('api_error');
    expect(text).toMatch(/^Error: .*HTTP 404/);
    expect(text).not.toContain('list_domains');
    expect(text).not.toContain(LIMIT_DETAILS_URL);
    expect(text).not.toMatch(PLAN_WORDS);
    expect(text).not.toContain('<');
  });

  it('answers a gateway error with no body the same way', async () => {
    const { outcome, text } = await call(() => new Response('', { status: 502 }), 'list_domains');

    expect(outcome).toBe('api_error');
    expect(text).toMatch(/^Error: .*HTTP 502/);
  });
});

describe('list_domains once GET /domains answers', () => {
  it('adds a note when the workspace has no custom domains', async () => {
    const { result, outcome } = await call(() => json([]), 'list_domains');

    expect(outcome).toBe('ok');
    expect(result.isError).toBeUndefined();
    expect(result.content.map((c) => c.text)).toEqual(['[]', NO_CUSTOM_DOMAINS_NOTE]);
  });

  it('names no domain and no tool in that note', () => {
    // The default shared domain depends on the plan, and the note must not
    // steer the model toward or away from any tool.
    expect(NO_CUSTOM_DOMAINS_NOTE).not.toMatch(/\b[a-z0-9-]+\.[a-z]{2,}\b/i);
    expect(NO_CUSTOM_DOMAINS_NOTE).not.toMatch(/\b[a-z]+_[a-z]+\b/);
  });

  it('adds no note to a list that has domains', async () => {
    const domain = { id: 'dom_1', slug: 'go.example.com', verified: true, primary: true, archived: false };
    const { result, outcome } = await call(() => json([domain]), 'list_domains');

    expect(outcome).toBe('ok');
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0].text)).toEqual([domain]);
  });

  it('adds no note to an empty later page or an empty search', async () => {
    for (const args of [{ page: 2 }, { search: 'acme' }]) {
      const { result } = await call(() => json([]), 'list_domains', args);

      expect(result.content, JSON.stringify(args)).toHaveLength(1);
    }
  });

  it('leaves an empty list_tags as it was', async () => {
    const { result } = await call(() => json([]), 'list_tags');

    expect(result.content.map((c) => c.text)).toEqual(['[]']);
  });
});

describe('pageSize on list_domains and list_tags', () => {
  const LISTS = [
    ['list_domains', DOMAINS_MAX_PAGE_SIZE],
    ['list_tags', TAGS_MAX_PAGE_SIZE],
  ] as const;

  it("advertises the API's own bounds", () => {
    for (const [name, max] of LISTS) {
      const properties = TOOLS.find((tool) => tool.name === name)?.inputSchema.properties as
        | Record<string, unknown>
        | undefined;

      expect(properties?.pageSize, name).toMatchObject({ type: 'number', minimum: 1, maximum: max });
    }
  });

  it('clamps a value from a client that predates the bounds, instead of relaying the 400', async () => {
    for (const [name, max] of LISTS) {
      for (const [sent, sentAs] of [
        [max + 1, max],
        [0, 1],
        [max - 1, max - 1],
      ]) {
        const { requests, outcome } = await call(() => json([]), name, { pageSize: sent });

        expect(outcome).toBe('ok');
        expect(requests[0].searchParams.get('pageSize'), `${name} ${sent}`).toBe(String(sentAs));
      }
    }
  });
});

describe('the list_domains pointer on a domain gate', () => {
  const gate = () =>
    json({ error: { code: 'forbidden', message: DOMAIN_GATE, doc_url: 'https://codeqr.io/docs/api-reference' } }, 403);

  it('is given to a create_link that named the domain', async () => {
    const { outcome, text } = await call(gate, 'create_link', { url: 'https://example.com', domain: 'example.sh' });

    expect(outcome).toBe('plan_limit');
    expect(text).toContain('list_domains');
    expect(text).not.toMatch(PLAN_WORDS);
  });

  it('is not given when the call left domain out, or when list_domains itself was refused', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['create_link', { url: 'https://example.com' }],
      ['list_domains', {}],
    ];
    for (const [name, args] of calls) {
      const { outcome, text } = await call(gate, name, args);

      expect(outcome, name).toBe('plan_limit');
      expect(text, name).not.toContain('list_domains');
      expect(text, name).not.toMatch(PLAN_WORDS);
    }
  });
});
