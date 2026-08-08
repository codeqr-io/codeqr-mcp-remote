import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What these cover is the one failure that is unrecoverable for the user.
 *
 * CodeQR treats a re-presented refresh token as theft and revokes the whole
 * token family, so a session that refreshes twice does not just waste a call —
 * it logs the user out and forces them to authorize again. An MCP client firing
 * tool calls in parallel is the ordinary case, not an edge case, which is why
 * "exactly one refresh" is asserted rather than "at least one".
 */

vi.mock('../src/oauth/codeqr-oauth.js', async (importOriginal) => {
  // needsRefresh stays real: the margin it applies is part of what decides
  // whether these paths are entered at all.
  const actual = await importOriginal<typeof import('../src/oauth/codeqr-oauth.js')>();
  return { ...actual, refreshCredentials: vi.fn() };
});

const { refreshCredentials } = await import('../src/oauth/codeqr-oauth.js');
const { resolveCodeQRToken } = await import('../src/oauth/refresh.js');
const { createAccessToken, validateAccessToken } = await import('../src/oauth/store.js');

const mockRefresh = vi.mocked(refreshCredentials);

const MINUTE = 60 * 1000;

async function sessionExpiringIn(ms: number) {
  const { token } = await createAccessToken({
    clientId: 'client_test',
    codeqr: {
      accessToken: 'codeqr_access_token_old',
      refreshToken: 'refresh_old',
      expiresAt: Date.now() + ms,
    },
    scope: 'mcp:tools',
  });

  const entry = await validateAccessToken(token);
  if (!entry) throw new Error('fixture failed: token did not validate');
  return entry;
}

beforeEach(() => {
  mockRefresh.mockReset();
  mockRefresh.mockResolvedValue({
    accessToken: 'codeqr_access_token_new',
    refreshToken: 'refresh_new',
    expiresAt: Date.now() + 7 * 24 * 60 * MINUTE,
  });
});

describe('resolveCodeQRToken', () => {
  it('renews only once when several tool calls race on the same session', async () => {
    const entry = await sessionExpiringIn(1 * MINUTE);
    mockRefresh.mockImplementation(async () => {
      // Any real network call leaves a window for the others to pile in; without
      // one the race this test exists for would not happen.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        accessToken: 'codeqr_access_token_new',
        refreshToken: 'refresh_new',
        expiresAt: Date.now() + 7 * 24 * 60 * MINUTE,
      };
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolveCodeQRToken(entry)),
    );

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(new Set(results)).toEqual(new Set(['codeqr_access_token_new']));
  });

  it('spends the refresh token exactly once', async () => {
    const entry = await sessionExpiringIn(1 * MINUTE);

    await Promise.all(Array.from({ length: 4 }, () => resolveCodeQRToken(entry)));

    // Presenting 'refresh_old' a second time is what triggers RFC 9700 reuse
    // detection on CodeQR's side and revokes everything.
    expect(mockRefresh.mock.calls).toEqual([['refresh_old']]);
  });

  it('persists the new credentials so the next request does not refresh again', async () => {
    const entry = await sessionExpiringIn(1 * MINUTE);

    await resolveCodeQRToken(entry);
    const stored = await validateAccessToken(entry.token);

    expect(stored?.codeqr).toMatchObject({
      accessToken: 'codeqr_access_token_new',
      refreshToken: 'refresh_new',
    });

    // Re-reading the session and resolving again must not call CodeQR a second
    // time — this is what stops every request from rotating the token.
    mockRefresh.mockClear();
    await resolveCodeQRToken(stored!);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('does not re-present a refresh token another instance already spent', async () => {
    // The fatal cross-instance case. Two servers read the same session while it
    // is still stale; one renews. The second now holds credentials that look
    // expired but whose refresh token has already been used — sending it is
    // what CodeQR reads as theft and answers by revoking the token family.
    const first = await sessionExpiringIn(1 * MINUTE);
    const second = await validateAccessToken(first.token);

    await resolveCodeQRToken(first);
    mockRefresh.mockClear();

    await expect(resolveCodeQRToken(second!)).resolves.toBe('codeqr_access_token_new');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('leaves a token that is still comfortably valid alone', async () => {
    const entry = await sessionExpiringIn(60 * MINUTE);

    await expect(resolveCodeQRToken(entry)).resolves.toBe('codeqr_access_token_old');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('renews inside the safety margin, before the token actually expires', async () => {
    // Still valid for 5 minutes, but inside the 10-minute margin: a batch of
    // tool calls starting now could otherwise expire midway through.
    const entry = await sessionExpiringIn(5 * MINUTE);

    await expect(resolveCodeQRToken(entry)).resolves.toBe('codeqr_access_token_new');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('uses a legacy API key session as-is, without contacting CodeQR', async () => {
    // Sessions created before the broker hold a personal API key, which does
    // not expire. Trying to refresh one would fail for no reason.
    const legacy = {
      token: 'cqr_mcp_legacy',
      clientId: 'client_test',
      codeqrApiKey: 'codeqr_personal_key',
      scope: 'mcp:tools',
      expiresAt: Date.now() + 30 * 24 * 60 * MINUTE,
    };

    await expect(resolveCodeQRToken(legacy)).resolves.toBe('codeqr_personal_key');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('fails loudly when a session carries no usable credential', async () => {
    const broken = {
      token: 'cqr_mcp_broken',
      clientId: 'client_test',
      scope: 'mcp:tools',
      expiresAt: Date.now() + MINUTE,
    };

    await expect(resolveCodeQRToken(broken)).rejects.toThrow(/neither/i);
  });

  it('surfaces a dead refresh token instead of returning a stale one', async () => {
    const entry = await sessionExpiringIn(1 * MINUTE);
    mockRefresh.mockRejectedValue(new Error('Refresh token expired'));

    await expect(resolveCodeQRToken(entry)).rejects.toThrow();

    // The caller must not fall back to the expired access token: the API would
    // reject it and the real cause would be lost.
    const stored = await validateAccessToken(entry.token);
    expect(stored?.codeqr?.accessToken).toBe('codeqr_access_token_old');
  });
});
