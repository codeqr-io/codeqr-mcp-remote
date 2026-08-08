/**
 * The workspace lookup is what makes `get_link_info` possible at all: the API
 * requires a `projectSlug` that no MCP client can know, so it has to come from
 * the credential. These cover the paths where that resolution fails, because a
 * silent failure here turns into a confusing error inside an unrelated tool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getWorkspace, clearWorkspaceCache, WorkspaceLookupError } from '../src/codeqr/workspace.js';

const OK_BODY = JSON.stringify({
  id: 'user_1',
  name: 'Demo',
  project: { id: 'prj_1', slug: 'acme', name: 'Acme', plan: 'pro' },
});

function respond(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe('getWorkspace', () => {
  beforeEach(() => {
    clearWorkspaceCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the workspace behind the credential', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(OK_BODY)));

    await expect(getWorkspace('key_1')).resolves.toEqual({
      id: 'prj_1',
      slug: 'acme',
      name: 'Acme',
      plan: 'pro',
    });
  });

  it('sends the credential as a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await getWorkspace('key_1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/oauth/userinfo');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key_1');
  });

  it('reuses the resolved workspace instead of asking again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await getWorkspace('key_1');
    await getWorkspace('key_1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps one credential’s workspace out of another’s', async () => {
    // Two people can be connected at once through the same server process. A
    // cache keyed loosely here would hand one of them the other's workspace
    // slug, and every lookup after that would read the wrong workspace.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(OK_BODY))
      .mockResolvedValueOnce(
        respond(JSON.stringify({ project: { id: 'prj_2', slug: 'globex', name: 'Globex', plan: 'free' } })),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getWorkspace('key_1')).resolves.toMatchObject({ slug: 'acme' });
    await expect(getWorkspace('key_2')).resolves.toMatchObject({ slug: 'globex' });
  });

  it('fails loudly when CodeQR rejects the credential', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond('{"error":"unauthorized"}', 401)));

    await expect(getWorkspace('key_1')).rejects.toBeInstanceOf(WorkspaceLookupError);
  });

  it('fails loudly when the response is not JSON', async () => {
    // A proxy or edge error answers HTML. Parsing it raw would throw a syntax
    // error that says nothing about what went wrong.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond('<html>502</html>')));

    await expect(getWorkspace('key_1')).rejects.toThrow(/non-JSON/);
  });

  it('fails loudly when the response carries no workspace', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(JSON.stringify({ id: 'user_1' }))));

    await expect(getWorkspace('key_1')).rejects.toThrow(/no workspace/);
  });

  it('surfaces a network failure as a readable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(getWorkspace('key_1')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('does not cache a failure', async () => {
    // A transient 500 must not poison every later call for this credential.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond('boom', 500))
      .mockResolvedValueOnce(respond(OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getWorkspace('key_1')).rejects.toBeInstanceOf(WorkspaceLookupError);
    await expect(getWorkspace('key_1')).resolves.toMatchObject({ slug: 'acme' });
  });
});
