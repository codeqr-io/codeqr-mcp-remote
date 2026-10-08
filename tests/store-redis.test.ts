import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The Upstash path is the one production runs; the rest of the suite uses the
 * in-memory maps. This fake keeps only what the access-token functions use,
 * with the two options whose semantics matter here: `ex` and `xx`.
 */
const { fake } = vi.hoisted(() => {
  type Entry = { value: unknown; expiresAt?: number };
  const data = new Map<string, Entry>();
  const live = (key: string) => {
    const entry = data.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) data.delete(key);
    return data.get(key);
  };
  return {
    fake: {
      data,
      /** Runs right after a GET returns, to simulate a change between read and write. */
      afterGet: undefined as undefined | ((key: string) => void),
      live,
    },
  };
});

vi.mock('@upstash/redis', () => ({
  Redis: class {
    async get(key: string) {
      const value = fake.live(key)?.value ?? null;
      fake.afterGet?.(key);
      return value;
    }
    async set(key: string, value: unknown, options: { ex?: number; xx?: boolean } = {}) {
      if (options.xx && !fake.live(key)) return null;
      fake.data.set(key, {
        value,
        expiresAt: options.ex === undefined ? undefined : Date.now() + options.ex * 1000,
      });
      return 'OK';
    }
    async del(key: string) {
      return fake.data.delete(key) ? 1 : 0;
    }
  },
}));

let store: typeof import('../src/oauth/store.js');

beforeAll(async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test_token';
  vi.resetModules();
  store = await import('../src/oauth/store.js');
});

afterAll(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

const DAY = 24 * 60 * 60 * 1000;
const credentials = (n: number) => ({
  accessToken: `a${n}`,
  refreshToken: `r${n}`,
  expiresAt: Date.now() + 7 * DAY,
});

describe('access tokens on Redis', () => {
  it('renews the stored deadline and the key TTL together on rotation, keeping the issue time', async () => {
    vi.useFakeTimers();
    try {
      const { token, expiresIn } = await store.createAccessToken({
        clientId: 'client_test',
        codeqr: credentials(0),
        scope: 'mcp:tools',
      });
      expect(expiresIn).toBe(store.MAX_SESSION_LIFETIME_SEC);
      const issued = Date.now();

      vi.advanceTimersByTime(30 * DAY);
      await store.updateAccessTokenCredentials(token, credentials(1));

      const entry = await store.validateAccessToken(token);
      const key = [...fake.data.keys()].find((k) => k.endsWith(token))!;
      expect(entry?.codeqr?.accessToken).toBe('a1');
      expect(entry?.createdAt).toBe(issued);
      expect(entry?.expiresAt).toBe(Date.now() + store.ACCESS_TOKEN_TTL_SEC * 1000);
      expect(fake.data.get(key)?.expiresAt).toBe(entry?.expiresAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not recreate a key that disappears between the read and the write', async () => {
    const { token } = await store.createAccessToken({
      clientId: 'client_test',
      codeqr: credentials(0),
      scope: 'mcp:tools',
    });
    const key = [...fake.data.keys()].find((k) => k.endsWith(token))!;

    fake.afterGet = (read) => {
      if (read === key) fake.data.delete(key);
    };
    try {
      await store.updateAccessTokenCredentials(token, credentials(1));
    } finally {
      fake.afterGet = undefined;
    }

    expect(fake.data.has(key)).toBe(false);
    expect(await store.validateAccessToken(token)).toBeNull();
  });
});
