/**
 * list_links and list_qrcodes through the real `@codeqr/ts` client with only
 * `fetch` faked, so the query string checked here is the one the API receives.
 */

import Codeqr from '@codeqr/ts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIST_PAGE_SIZE, LINKS_MAX_PAGE_SIZE, QRCODES_MAX_PAGE_SIZE } from '../src/list-tools.js';
import { handleToolCall, TOOLS } from '../src/routes/mcp.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function fakeClient(body: unknown, requests: URL[]) {
  return new Codeqr({
    apiKey: 'key',
    baseURL: 'https://api.codeqr.test',
    maxRetries: 0,
    fetch: async (input: string | URL | Request) => {
      requests.push(new URL(input instanceof Request ? input.url : input));
      return json(body);
    },
  });
}

async function call(body: unknown, name: string, args: Record<string, unknown> = {}) {
  const requests: URL[] = [];
  const result = await handleToolCall(fakeClient(body, requests), 'key', name, args);
  return { result, requests, texts: result.content.map((c) => c.text) };
}

const items = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `item_${i}` }));

const LISTS = [
  ['list_links', LINKS_MAX_PAGE_SIZE],
  ['list_qrcodes', QRCODES_MAX_PAGE_SIZE],
] as const;

describe('page size on list_links and list_qrcodes', () => {
  it("advertises the API's own maximum", () => {
    for (const [name, max] of LISTS) {
      const properties = TOOLS.find((tool) => tool.name === name)?.inputSchema.properties as Record<string, unknown>;

      expect(properties.pageSize, name).toMatchObject({ type: 'number', minimum: 1, maximum: max });
    }
  });

  it('asks for a small page when the caller names none, instead of the API default of 100', async () => {
    for (const [name] of LISTS) {
      const { requests } = await call([], name);

      expect(requests[0].searchParams.get('pageSize'), name).toBe(String(DEFAULT_LIST_PAGE_SIZE));
    }
  });

  it('answers a call that leaves arguments out, which MCP allows', async () => {
    for (const [name] of LISTS) {
      const requests: URL[] = [];
      // Cast because the parameter is typed for the common case; at runtime the SDK passes undefined.
      const result = await handleToolCall(fakeClient([], requests), 'key', name, undefined as never);

      expect(result.isError, name).toBeUndefined();
      expect(requests[0].searchParams.get('pageSize'), name).toBe(String(DEFAULT_LIST_PAGE_SIZE));
    }
  });

  it('keeps a page size the caller chose, clamped to what the API accepts', async () => {
    for (const [name, max] of LISTS) {
      const chosen = await call([], name, { pageSize: 50 });
      const tooLarge = await call([], name, { pageSize: max + 1 });

      expect(chosen.requests[0].searchParams.get('pageSize'), name).toBe('50');
      expect(tooLarge.requests[0].searchParams.get('pageSize'), name).toBe(String(max));
    }
  });
});

describe('the note after a full page', () => {
  it('points at the next page when the page came back full', async () => {
    for (const [name] of LISTS) {
      const { texts } = await call(items(DEFAULT_LIST_PAGE_SIZE), name, { page: 2 });

      expect(texts, name).toHaveLength(2);
      expect(texts[1], name).toContain('page 3');
    }
  });

  it('adds nothing to a page shorter than the page size', async () => {
    for (const [name] of LISTS) {
      const { texts } = await call(items(DEFAULT_LIST_PAGE_SIZE - 1), name);

      expect(texts, name).toHaveLength(1);
    }
  });
});
