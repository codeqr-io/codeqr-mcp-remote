import { describe, expect, it } from 'vitest';
import {
  acquireRefreshLock,
  consumePendingAuthorization,
  createAccessToken,
  createPendingAuthorization,
  releaseRefreshLock,
  updateAccessTokenCredentials,
  validateAccessToken,
} from '../src/oauth/store.js';

const MINUTE = 60 * 1000;

const pendingFixture = {
  clientId: 'client_test',
  redirectUri: 'https://chatgpt.test/callback',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256',
  clientState: 'client-state',
  scope: 'mcp:tools',
};

describe('pending authorizations', () => {
  it('round-trips everything the callback needs to answer the client', async () => {
    const state = await createPendingAuthorization(pendingFixture);

    await expect(consumePendingAuthorization(state)).resolves.toMatchObject(pendingFixture);
  });

  it('is single-use', async () => {
    const state = await createPendingAuthorization(pendingFixture);

    await consumePendingAuthorization(state);

    // A replayed callback must not be able to mint a second authorization code
    // for the same approval.
    await expect(consumePendingAuthorization(state)).resolves.toBeNull();
  });

  it('does not resolve a state it never issued', async () => {
    await expect(consumePendingAuthorization('forged-state')).resolves.toBeNull();
  });

  it('gives each request its own unguessable state', async () => {
    const a = await createPendingAuthorization(pendingFixture);
    const b = await createPendingAuthorization(pendingFixture);

    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe('refresh lock', () => {
  it('admits one holder at a time', async () => {
    const token = 'cqr_mcp_lock_a';

    await expect(acquireRefreshLock(token)).resolves.toBe(true);
    await expect(acquireRefreshLock(token)).resolves.toBe(false);
  });

  it('lets the next caller in once released', async () => {
    const token = 'cqr_mcp_lock_b';

    await acquireRefreshLock(token);
    await releaseRefreshLock(token);

    await expect(acquireRefreshLock(token)).resolves.toBe(true);
  });

  it('locks per session, not globally', async () => {
    // A shared lock would serialize every user's refresh behind one another.
    await acquireRefreshLock('cqr_mcp_lock_c');

    await expect(acquireRefreshLock('cqr_mcp_lock_d')).resolves.toBe(true);
  });
});

describe('updateAccessTokenCredentials', () => {
  it('replaces the credentials without extending the session', async () => {
    const { token, expiresIn } = await createAccessToken({
      clientId: 'client_test',
      codeqr: { accessToken: 'old', refreshToken: 'r_old', expiresAt: Date.now() + MINUTE },
      scope: 'mcp:tools',
    });

    const before = await validateAccessToken(token);
    await updateAccessTokenCredentials(token, {
      accessToken: 'new',
      refreshToken: 'r_new',
      expiresAt: Date.now() + 7 * 24 * 60 * MINUTE,
    });
    const after = await validateAccessToken(token);

    expect(after?.codeqr?.accessToken).toBe('new');
    // Rotating the CodeQR token underneath must not silently extend the life of
    // the MCP session above it.
    expect(after?.expiresAt).toBe(before?.expiresAt);
    expect(expiresIn).toBe(120 * 24 * 60 * 60);
  });

  it('drops the legacy API key once a session moves to OAuth credentials', async () => {
    const { token } = await createAccessToken({
      clientId: 'client_test',
      codeqr: { accessToken: 'old', refreshToken: 'r_old', expiresAt: Date.now() + MINUTE },
      scope: 'mcp:tools',
    });

    await updateAccessTokenCredentials(token, {
      accessToken: 'new',
      refreshToken: 'r_new',
      expiresAt: Date.now() + MINUTE,
    });

    expect((await validateAccessToken(token))?.codeqrApiKey).toBeUndefined();
  });

  it('ignores a token that no longer exists', async () => {
    await expect(
      updateAccessTokenCredentials('cqr_mcp_gone', {
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: Date.now() + MINUTE,
      }),
    ).resolves.toBeUndefined();
  });
});
