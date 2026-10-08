import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CODEQR_APP_URL = 'https://app.example.test';
process.env.CODEQR_OAUTH_CLIENT_ID = 'codeqr_app_test';
process.env.CODEQR_OAUTH_CLIENT_SECRET = 'secret_test';

vi.mock('../src/oauth/codeqr-oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/oauth/codeqr-oauth.js')>();
  return { ...actual, exchangeCodeForCredentials: vi.fn() };
});

const { exchangeCodeForCredentials } = await import('../src/oauth/codeqr-oauth.js');
const { createOAuthRouter } = await import('../src/routes/oauth.js');
const { BINDING_COOKIE } = await import('../src/oauth/browser-binding.js');
const { requireBearerToken } = await import('../src/middleware/auth.js');
const { handleToolCall } = await import('../src/routes/mcp.js');
const { keyHashPrefix } = await import('../src/telemetry.js');

const mockExchange = vi.mocked(exchangeCodeForCredentials);

const CLIENT_REDIRECT = 'https://chatgpt.test/callback';
const CODEQR_ACCESS = 'cq_access_SECRET_aaaa1111bbbb2222';
const CODEQR_REFRESH = 'cq_refresh_SECRET_cccc3333dddd4444';
const CODEQR_CODE = 'cq_code_SECRET_eeee5555ffff6666';

let lines: Array<Record<string, unknown>>;
let rawOutput: string;

beforeEach(() => {
  lines = [];
  rawOutput = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    for (const raw of String(chunk).split('\n')) {
      if (!raw.trim()) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.service === 'mcp') {
          lines.push(parsed);
          rawOutput += `${raw}\n`;
        }
      } catch {
        // not one of ours
      }
    }
    return true;
  }) as typeof process.stdout.write);
  mockExchange.mockReset();
  mockExchange.mockResolvedValue({
    accessToken: CODEQR_ACCESS,
    refreshToken: CODEQR_REFRESH,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

let addressCounter = 0;
function nextAddress() {
  addressCounter += 1;
  return `10.77.${Math.floor(addressCounter / 250)}.${addressCounter % 250}`;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/oauth', createOAuthRouter());
  return app;
}

function pkce() {
  const verifier = `verifier-${'v'.repeat(40)}-${Math.random().toString(36).slice(2)}`;
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeParams(clientId: string, challenge: string) {
  return {
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state-1',
  };
}

function bindingFrom(response: request.Response): string {
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith(`${BINDING_COOKIE}=`))!;
  return cookie.slice(BINDING_COOKIE.length + 1).split(';')[0];
}

const cookieHeader = (binding: string) => `${BINDING_COOKIE}=${binding}`;

async function registerClient(app: express.Express) {
  const response = await request(app)
    .post('/oauth/register')
    .set('x-real-ip', nextAddress())
    .send({ client_name: 'Test Client', redirect_uris: [CLIENT_REDIRECT] });
  return response.body.client_id as string;
}

async function approve(app: express.Express, clientId: string, challenge: string) {
  const shown = await request(app).get('/oauth/authorize').query(authorizeParams(clientId, challenge));
  const binding = bindingFrom(shown);
  const response = await request(app)
    .post('/oauth/authorize')
    .type('form')
    .set('Cookie', cookieHeader(binding))
    .send({ ...authorizeParams(clientId, challenge), csrf_token: binding, decision: 'approve' });
  const brokerState = new URL(response.headers.location).searchParams.get('state')!;
  return { binding, brokerState };
}

/** Runs the flow up to the redirect back to the client; returns the code the MCP server issued. */
async function reachClientCode(app: express.Express) {
  const clientId = await registerClient(app);
  const { verifier, challenge } = pkce();
  const { binding, brokerState } = await approve(app, clientId, challenge);
  const callback = await request(app)
    .get('/oauth/callback')
    .set('Cookie', cookieHeader(binding))
    .query({ code: CODEQR_CODE, state: brokerState });
  const mcpCode = new URL(callback.headers.location).searchParams.get('code')!;
  return { clientId, verifier, mcpCode, brokerState, binding };
}

function tokenRequest(app: express.Express, body: Record<string, unknown>) {
  return request(app).post('/oauth/token').send(body);
}

function eventOf(event: string, predicate: (l: Record<string, unknown>) => boolean = () => true) {
  return lines.find((l) => l.event === event && predicate(l));
}

describe('OAuth funnel events', () => {
  it('emits register, consent shown, consent approve, callback ok, token ok in order, without any secret', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { verifier, challenge } = pkce();
    const { binding, brokerState } = await approve(app, clientId, challenge);
    const callback = await request(app)
      .get('/oauth/callback')
      .set('Cookie', cookieHeader(binding))
      .query({ code: CODEQR_CODE, state: brokerState });
    const mcpCode = new URL(callback.headers.location).searchParams.get('code')!;
    const token = await tokenRequest(app, {
      grant_type: 'authorization_code',
      code: mcpCode,
      redirect_uri: CLIENT_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    const returnedAccessToken = token.body.access_token as string;

    expect(token.status).toBe(200);
    expect(lines.map((l) => [l.event, l.outcome ?? l.decision])).toEqual([
      ['oauth.register', 'ok'],
      ['oauth.consent', 'shown'],
      ['oauth.consent', 'approve'],
      ['oauth.callback', 'ok'],
      ['oauth.token', 'ok'],
    ]);

    const expectedPrefix = keyHashPrefix(CODEQR_ACCESS);
    expect(eventOf('oauth.callback')!.keyHashPrefix).toBe(expectedPrefix);
    expect(eventOf('oauth.token')!.keyHashPrefix).toBe(expectedPrefix);

    const secrets = {
      codeqrAccess: CODEQR_ACCESS,
      codeqrRefresh: CODEQR_REFRESH,
      codeqrCode: CODEQR_CODE,
      mcpCode,
      verifier,
      returnedAccessToken,
    };
    for (const [name, value] of Object.entries(secrets)) {
      expect(typeof value === 'string' && value.length > 0, `${name} must not be empty`).toBe(true);
      expect(rawOutput.includes(value), `${name} leaked into a log line`).toBe(false);
    }
    expect(new Set(Object.values(secrets)).size).toBe(Object.keys(secrets).length);
  });

  it('logs the deny decision', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { challenge } = pkce();
    const shown = await request(app).get('/oauth/authorize').query(authorizeParams(clientId, challenge));
    const binding = bindingFrom(shown);
    await request(app)
      .post('/oauth/authorize')
      .type('form')
      .set('Cookie', cookieHeader(binding))
      .send({ ...authorizeParams(clientId, challenge), csrf_token: binding, decision: 'deny' });

    expect(eventOf('oauth.consent', (l) => l.decision === 'deny')?.clientId).toBe(clientId);
  });
});

describe('callback error reasons', () => {
  const callbackReason = () => lines.filter((l) => l.event === 'oauth.callback').map((l) => [l.outcome, l.reason]);

  it('missing_state', async () => {
    await request(makeApp()).get('/oauth/callback').query({ code: 'c' });

    expect(callbackReason()).toEqual([['error', 'missing_state']]);
  });

  it('expired_or_used for an unknown state', async () => {
    await request(makeApp()).get('/oauth/callback').query({ code: 'c', state: 'never-issued' });

    expect(callbackReason()).toEqual([['error', 'expired_or_used']]);
  });

  it('other_browser', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { challenge } = pkce();
    const { brokerState } = await approve(app, clientId, challenge);

    await request(app).get('/oauth/callback').query({ code: 'c', state: brokerState });

    expect(callbackReason()).toEqual([['error', 'other_browser']]);
    expect(eventOf('oauth.callback')!.clientId).toBe(clientId);
  });

  it('codeqr_access_denied when CodeQR sends error=access_denied', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { challenge } = pkce();
    const { binding, brokerState } = await approve(app, clientId, challenge);

    await request(app)
      .get('/oauth/callback')
      .set('Cookie', cookieHeader(binding))
      .query({ error: 'access_denied', state: brokerState });

    expect(callbackReason()).toEqual([['error', 'codeqr_access_denied']]);
  });

  it('exchange_failed when the code exchange throws', async () => {
    mockExchange.mockRejectedValue(new Error('exchange boom'));
    const app = makeApp();
    const clientId = await registerClient(app);
    const { challenge } = pkce();
    const { binding, brokerState } = await approve(app, clientId, challenge);

    await request(app)
      .get('/oauth/callback')
      .set('Cookie', cookieHeader(binding))
      .query({ code: CODEQR_CODE, state: brokerState });

    expect(callbackReason()).toEqual([['error', 'exchange_failed']]);
  });
});

describe('token error reasons', () => {
  const tokenReason = () => lines.filter((l) => l.event === 'oauth.token').map((l) => [l.outcome, l.reason]);

  it('unsupported_grant_type', async () => {
    await tokenRequest(makeApp(), { grant_type: 'password' });

    expect(tokenReason()).toEqual([['error', 'unsupported_grant_type']]);
  });

  it('missing_code_or_verifier', async () => {
    await tokenRequest(makeApp(), { grant_type: 'authorization_code', code: 'x' });

    expect(tokenReason()).toEqual([['error', 'missing_code_or_verifier']]);
  });

  it('invalid_or_expired_code', async () => {
    await tokenRequest(makeApp(), { grant_type: 'authorization_code', code: 'nope', code_verifier: 'v' });

    expect(tokenReason()).toEqual([['error', 'invalid_or_expired_code']]);
  });

  it('pkce_failed', async () => {
    const app = makeApp();
    const { clientId, mcpCode } = await reachClientCode(app);
    lines.length = 0;

    await tokenRequest(app, {
      grant_type: 'authorization_code',
      code: mcpCode,
      redirect_uri: CLIENT_REDIRECT,
      client_id: clientId,
      code_verifier: 'not-the-verifier',
    });

    expect(tokenReason()).toEqual([['error', 'pkce_failed']]);
    expect(eventOf('oauth.token')!.clientId).toBe(clientId);
  });

  it('client_mismatch', async () => {
    const app = makeApp();
    const { clientId, mcpCode, verifier } = await reachClientCode(app);
    lines.length = 0;

    await tokenRequest(app, {
      grant_type: 'authorization_code',
      code: mcpCode,
      redirect_uri: CLIENT_REDIRECT,
      client_id: `${clientId}-other`,
      code_verifier: verifier,
    });

    expect(tokenReason()).toEqual([['error', 'client_mismatch']]);
    expect(eventOf('oauth.token')!.clientId).toBe(clientId);
  });
});

describe('requireBearerToken rejections', () => {
  const USER_AGENT = 'probe-scanner/1.0';

  function authApp() {
    const app = express();
    app.use(requireBearerToken);
    app.get('/mcp', (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  const rejected = () => lines.filter((l) => l.event === 'mcp.rejected');

  it('missing_authorization without a header', async () => {
    const res = await request(authApp()).get('/mcp').set('User-Agent', USER_AGENT);

    expect(res.status).toBe(401);
    expect(rejected()).toHaveLength(1);
    expect(rejected()[0]).toMatchObject({ status: res.status, reason: 'missing_authorization', userAgent: USER_AGENT });
  });

  it('malformed_authorization for a non-Bearer scheme', async () => {
    const res = await request(authApp()).get('/mcp').set('User-Agent', USER_AGENT).set('Authorization', 'Basic x');

    expect(rejected()[0]).toMatchObject({ status: res.status, reason: 'malformed_authorization', userAgent: USER_AGENT });
  });

  it('unknown_or_expired_token for an unknown Bearer', async () => {
    const secret = 'unknown-bearer-SECRET-123456';
    const res = await request(authApp())
      .get('/mcp')
      .set('User-Agent', USER_AGENT)
      .set('Authorization', `Bearer ${secret}`);

    expect(rejected()[0]).toMatchObject({ status: res.status, reason: 'unknown_or_expired_token', userAgent: USER_AGENT });
    expect(rawOutput).not.toContain(secret);
  });
});

describe('handleToolCall onOutcome', () => {
  function apiError(status: number, code: string, message: string) {
    const body = { error: { code, message, doc_url: 'https://codeqr.io/docs/api-reference' } };
    return Object.assign(new Error(`${status} ${JSON.stringify(body)}`), { status, error: body });
  }

  const PLAN_GATE =
    'Smart rules are available on the Business plan and above. Upgrade to Business to use this feature.';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (client: unknown, name: string, args: Record<string, unknown>, onOutcome?: (o: any) => void) =>
    handleToolCall(client as never, 'key', name, args, onOutcome);

  const validArgs = { url: 'https://example.com' };
  const invalidRules = {
    url: 'https://example.com',
    rules: [{ split: [{ url: 'https://example.com/a', weight: 60 }, { url: 'https://example.com/b', weight: 60 }] }],
  };

  const cases: Array<{
    label: string;
    expected: string;
    name: string;
    args: Record<string, unknown>;
    create: () => Promise<unknown>;
  }> = [
    { label: 'unknown tool', expected: 'unknown_tool', name: 'no_such_tool', args: {}, create: async () => ({}) },
    { label: 'invalid smart rules', expected: 'invalid_arguments', name: 'create_link', args: invalidRules, create: async () => ({}) },
    { label: 'client resolves', expected: 'ok', name: 'create_link', args: validArgs, create: async () => ({ id: 'link_1' }) },
    {
      label: 'plan limit error',
      expected: 'plan_limit',
      name: 'create_link',
      args: validArgs,
      create: async () => {
        throw apiError(403, 'forbidden', PLAN_GATE);
      },
    },
    {
      label: 'generic error',
      expected: 'api_error',
      name: 'create_link',
      args: validArgs,
      create: async () => {
        throw new Error('boom');
      },
    },
  ];

  it.each(cases)('reports $expected for $label and returns the same result as without onOutcome', async (c) => {
    const client = { links: { create: vi.fn(c.create) } };
    const outcomes: string[] = [];

    const withCallback = await run(client, c.name, c.args, (o) => outcomes.push(o));
    const without = await run(client, c.name, c.args);

    expect(outcomes).toEqual([c.expected]);
    expect(withCallback).toEqual(without);
  });
});
