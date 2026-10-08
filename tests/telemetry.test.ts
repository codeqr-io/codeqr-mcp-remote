import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_FIELDS,
  KEY_HASH_PREFIX_LENGTH,
  MAX_FIELD_LENGTH,
  keyHashPrefix,
  logEvent,
  type EventFields,
} from '../src/telemetry.js';

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
const globals = globalThis as unknown as Record<symbol, unknown>;

let lines: Array<Record<string, unknown>>;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.AXIOM_TOKEN;
  delete process.env.AXIOM_DATASET;
  lines = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    for (const raw of String(chunk).split('\n')) {
      if (!raw.trim()) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.service === 'mcp') lines.push(parsed);
      } catch {
        // not one of ours
      }
    }
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete globals[REQUEST_CONTEXT];
  process.env = savedEnv;
});

describe('logEvent line shape', () => {
  it('writes _time, service and event, and only fields from EVENT_FIELDS', () => {
    const smuggled = {
      outcome: 'ok',
      clientId: 'client_1',
      token: 'tok-secret',
      code: 'code-secret',
      email: 'someone@example.test',
      authorization: 'Bearer secret',
    } as unknown as EventFields;

    logEvent('oauth.token', smuggled);

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.service).toBe('mcp');
    expect(line.event).toBe('oauth.token');
    expect(Number.isNaN(Date.parse(String(line._time)))).toBe(false);

    const allowed = new Set<string>(['_time', 'service', 'event', ...EVENT_FIELDS]);
    for (const key of Object.keys(line)) expect(allowed.has(key), key).toBe(true);
    for (const key of ['token', 'code', 'email', 'authorization']) expect(line).not.toHaveProperty(key);
    expect(JSON.stringify(line)).not.toMatch(/secret|someone@example/);
    expect(line.outcome).toBe('ok');
    expect(line.clientId).toBe('client_1');
  });

  it('truncates string fields to exactly MAX_FIELD_LENGTH', () => {
    logEvent('mcp.rejected', { userAgent: 'u'.repeat(MAX_FIELD_LENGTH * 3) });

    expect((lines[0].userAgent as string).length).toBe(MAX_FIELD_LENGTH);
  });

  it('keeps a string of exactly MAX_FIELD_LENGTH intact', () => {
    const exact = 'a'.repeat(MAX_FIELD_LENGTH);
    logEvent('mcp.rejected', { userAgent: exact });

    expect(lines[0].userAgent).toBe(exact);
  });
});

describe('keyHashPrefix', () => {
  const tokens = ['codeqr_access_token_x', 'another-token-9f8e7d', 'Z'.repeat(64), 'tok with spaces é'];

  it.each(tokens)('matches the hashToken computation for %s', async (token) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    expect(keyHashPrefix(token)).toBe(hex.slice(0, KEY_HASH_PREFIX_LENGTH));
    expect(keyHashPrefix(token)).toBe(createHash('sha256').update(token).digest('hex').slice(0, KEY_HASH_PREFIX_LENGTH));
  });

  it('differs between tokens', () => {
    expect(new Set(tokens.map(keyHashPrefix)).size).toBe(tokens.length);
  });
});

describe('Axiom delivery', () => {
  it('does not call fetch without AXIOM_TOKEN', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    logEvent('oauth.register', { outcome: 'ok' });

    expect(lines).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the same object as the stdout line to the dataset ingest URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.AXIOM_TOKEN = 'axiom-token-1';
    process.env.AXIOM_DATASET = 'x';

    logEvent('oauth.register', { outcome: 'ok', clientId: 'c1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url).endsWith('/v1/datasets/x/ingest')).toBe(true);
    expect(init.headers.Authorization).toBe(`Bearer ${process.env.AXIOM_TOKEN}`);
    const body = JSON.parse(init.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([lines[0]]);
  });

  it('falls back to the default dataset when AXIOM_DATASET is unset', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.AXIOM_TOKEN = 'axiom-token-1';

    logEvent('oauth.register', { outcome: 'ok' });

    expect(String(fetchMock.mock.calls[0][0]).endsWith('/v1/datasets/codeqr/ingest')).toBe(true);
  });

  it('does not throw nor reject when fetch rejects', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    process.env.AXIOM_TOKEN = 'axiom-token-1';

    expect(() => logEvent('oauth.register', { outcome: 'ok' })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', unhandled);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('hands the send to the Vercel request context waitUntil', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const waitUntil = vi.fn();
    globals[REQUEST_CONTEXT] = { get: () => ({ waitUntil }) };
    process.env.AXIOM_TOKEN = 'axiom-token-1';

    logEvent('oauth.register', { outcome: 'ok' });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });
});
