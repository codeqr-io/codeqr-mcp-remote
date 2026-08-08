/**
 * Backs the `get_workspace` tool. These cover the failure paths, because the
 * lookup crosses to a second host — a reachability problem here has to read as
 * one, not as a vague tool error.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { getWorkspace, WorkspaceLookupError } from '../src/codeqr/workspace.js';

const OK_BODY = JSON.stringify({
  id: 'user_1',
  name: 'Demo',
  project: { id: 'prj_1', slug: 'acme', name: 'Acme', plan: 'pro' },
});

function respond(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe('getWorkspace', () => {
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

  it('asks CodeQR every time instead of remembering an answer', async () => {
    // Nothing is cached on purpose. Holding the result meant a renamed
    // workspace kept serving a stale slug, and the cache key was the raw
    // credential — a secret retained for the life of the process.
    // A fresh Response per call, not one reused: a body can only be read once,
    // so a shared instance would fail on the second read for reasons that have
    // nothing to do with what is being tested.
    const fetchMock = vi.fn().mockImplementation(async () => respond(OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await getWorkspace('key_1');
    await getWorkspace('key_1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads each credential’s own workspace', async () => {
    // Two people can be connected at once through the same process, so a
    // lookup that leaked between them would report the wrong workspace.
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

  it('recovers on the next call after a transient failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond('boom', 500))
      .mockResolvedValueOnce(respond(OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getWorkspace('key_1')).rejects.toBeInstanceOf(WorkspaceLookupError);
    await expect(getWorkspace('key_1')).resolves.toMatchObject({ slug: 'acme' });
  });
});
