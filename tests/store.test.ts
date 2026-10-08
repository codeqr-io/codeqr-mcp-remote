import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SEC,
  MAX_SESSION_LIFETIME_SEC,
  issuedAt,
  renewedExpiry,
  acquireRefreshLock,
  allowRegistration,
  consumePendingAuthorization,
  createAccessToken,
  createPendingAuthorization,
  getRegisteredClient,
  markClientUsed,
  registerClient,
  REGISTRATION_LIMIT,
  REGISTRATION_WINDOW_SEC,
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
  browserBinding: 'b'.repeat(32),
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
  it('replaces the credentials and gives the session the full lifetime from the rotation', async () => {
    vi.useFakeTimers();
    try {
      const { token, expiresIn } = await createAccessToken({
        clientId: 'client_test',
        codeqr: { accessToken: 'old', refreshToken: 'r_old', expiresAt: Date.now() + MINUTE },
        scope: 'mcp:tools',
      });
      // The client is told the ceiling; the stored deadline is one lifetime.
      expect(expiresIn).toBe(MAX_SESSION_LIFETIME_SEC);
      const before = await validateAccessToken(token);

      // A rotation 30 days into the session.
      vi.advanceTimersByTime(30 * 24 * 60 * MINUTE);
      const rotatedAt = Date.now();
      await updateAccessTokenCredentials(token, {
        accessToken: 'new',
        refreshToken: 'r_new',
        expiresAt: rotatedAt + 7 * 24 * 60 * MINUTE,
      });
      const after = await validateAccessToken(token);

      expect(after?.codeqr?.accessToken).toBe('new');
      expect(after?.expiresAt).toBe(rotatedAt + ACCESS_TOKEN_TTL_SEC * 1000);
      expect(after!.expiresAt).toBeGreaterThan(before!.expiresAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never brings back a session that is already past its deadline', async () => {
    vi.useFakeTimers();
    try {
      const { token } = await createAccessToken({
        clientId: 'client_test',
        codeqr: { accessToken: 'old', refreshToken: 'r_old', expiresAt: Date.now() + MINUTE },
        scope: 'mcp:tools',
      });

      vi.advanceTimersByTime(ACCESS_TOKEN_TTL_SEC * 1000 + MINUTE);
      await updateAccessTokenCredentials(token, {
        accessToken: 'new',
        refreshToken: 'r_new',
        expiresAt: Date.now() + MINUTE,
      });

      expect(await validateAccessToken(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

describe('session lifetime ceiling', () => {
  const DAY = 24 * 60 * MINUTE;
  const TTL = ACCESS_TOKEN_TTL_SEC * 1000;
  const CEILING = MAX_SESSION_LIFETIME_SEC * 1000;

  it('gives a full lifetime from the rotation while far from the ceiling', () => {
    const createdAt = 1_000_000;
    const now = createdAt + 30 * DAY;
    expect(renewedExpiry({ createdAt, expiresAt: createdAt + TTL }, now)).toBe(now + TTL);
  });

  it('never goes past the ceiling counted from issue', () => {
    const createdAt = 1_000_000;
    const now = createdAt + CEILING - 10 * DAY;
    expect(renewedExpiry({ createdAt, expiresAt: now + DAY }, now)).toBe(createdAt + CEILING);
  });

  it('derives the issue time of a session recorded before createdAt existed', () => {
    const issued = 1_000_000;
    const legacy = { expiresAt: issued + TTL };
    expect(issuedAt(legacy)).toBe(issued);
    expect(renewedExpiry(legacy, issued + CEILING - DAY)).toBe(issued + CEILING);
  });

  it('stops renewing a session used all along once it reaches the ceiling', async () => {
    vi.useFakeTimers();
    try {
      const { token } = await createAccessToken({
        clientId: 'client_test',
        codeqr: { accessToken: 'a0', refreshToken: 'r0', expiresAt: Date.now() + MINUTE },
        scope: 'mcp:tools',
      });
      const issued = Date.now();

      // A rotation every 100 days, each while the session is still valid.
      for (let i = 1; (i * 100 * DAY) < CEILING; i++) {
        vi.setSystemTime(issued + i * 100 * DAY);
        await updateAccessTokenCredentials(token, {
          accessToken: `a${i}`,
          refreshToken: `r${i}`,
          expiresAt: Date.now() + 7 * DAY,
        });
        const entry = await validateAccessToken(token);
        expect(entry?.expiresAt).toBeLessThanOrEqual(issued + CEILING);
      }

      vi.setSystemTime(issued + CEILING + MINUTE);
      expect(await validateAccessToken(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('registered clients', () => {
  const DAY = 24 * 60 * MINUTE;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a registration nobody ever authorized with', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const client = await registerClient({ clientName: 'Unused', redirectUris: ['https://a.test/cb'] });

    vi.setSystemTime(Date.now() + 31 * DAY);

    await expect(getRegisteredClient(client.clientId)).resolves.toBeNull();
  });

  it('keeps a registration for good once an authorization completed with it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const client = await registerClient({ clientName: 'Used', redirectUris: ['https://a.test/cb'] });

    await markClientUsed(client.clientId);
    // Past the unused TTL and past the 120-day token, when clients re-authorize
    // with the client_id they cached.
    vi.setSystemTime(Date.now() + 200 * DAY);

    await expect(getRegisteredClient(client.clientId)).resolves.toMatchObject({ clientName: 'Used' });
  });
});

describe('registration rate limit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits REGISTRATION_LIMIT attempts per source and window', async () => {
    const results = [];
    for (let i = 0; i <= REGISTRATION_LIMIT; i++) results.push(await allowRegistration('10.0.0.1'));

    expect(results.slice(0, REGISTRATION_LIMIT).every(Boolean)).toBe(true);
    expect(results[REGISTRATION_LIMIT]).toBe(false);
    await expect(allowRegistration('10.0.0.2')).resolves.toBe(true);
  });

  it('starts over in the next window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i <= REGISTRATION_LIMIT; i++) await allowRegistration('10.0.0.3');

    vi.setSystemTime(Date.now() + REGISTRATION_WINDOW_SEC * 1000);

    await expect(allowRegistration('10.0.0.3')).resolves.toBe(true);
  });
});
