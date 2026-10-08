import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every check in this file fails open: deleting the redirect_uri match, the
 * consent screen, its CSRF check or the browser binding on the callback breaks
 * nothing that any other test watches — the flow keeps "working", it just hands
 * codes to whoever asks.
 */

process.env.CODEQR_APP_URL = 'https://app.example.test';
process.env.CODEQR_OAUTH_CLIENT_ID = 'codeqr_app_test';
process.env.CODEQR_OAUTH_CLIENT_SECRET = 'secret_test';

vi.mock('../src/oauth/codeqr-oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/oauth/codeqr-oauth.js')>();
  return { ...actual, exchangeCodeForCredentials: vi.fn() };
});

const { exchangeCodeForCredentials } = await import('../src/oauth/codeqr-oauth.js');
const { createOAuthRouter } = await import('../src/routes/oauth.js');
const store = await import('../src/oauth/store.js');
const { BINDING_COOKIE } = await import('../src/oauth/browser-binding.js');

const mockExchange = vi.mocked(exchangeCodeForCredentials);

const CLIENT_REDIRECT = 'https://chatgpt.test/callback';

// Registration is rate limited per address, so each call in this file comes
// from its own, or the suite would trip the limit it is not testing.
let addressCounter = 0;
function nextAddress() {
  addressCounter += 1;
  return `10.1.${Math.floor(addressCounter / 250)}.${addressCounter % 250}`;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/oauth', createOAuthRouter());
  return app;
}

function register(app: express.Express, body: Record<string, unknown>) {
  return request(app).post('/oauth/register').set('x-real-ip', nextAddress()).send(body);
}

async function registerClient(app: express.Express, clientName = 'Test Client') {
  const response = await register(app, { client_name: clientName, redirect_uris: [CLIENT_REDIRECT] });
  return response.body.client_id as string;
}

function authorizeParams(clientId: string) {
  return {
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    response_type: 'code',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'client-state-1',
  };
}

function bindingFrom(response: request.Response): string | undefined {
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith(`${BINDING_COOKIE}=`));
  return cookie?.slice(BINDING_COOKIE.length + 1).split(';')[0];
}

function cookieHeader(binding: string) {
  return `${BINDING_COOKIE}=${binding}`;
}

/** The consent screen as the user's browser receives it. */
async function showConsent(app: express.Express, clientId: string) {
  const response = await request(app).get('/oauth/authorize').query(authorizeParams(clientId));
  return { response, binding: bindingFrom(response)! };
}

function submitConsent(
  app: express.Express,
  clientId: string,
  opts: { binding?: string; csrf?: string; decision?: string; overrides?: Record<string, string> },
) {
  const req = request(app).post('/oauth/authorize').type('form');
  if (opts.binding) req.set('Cookie', cookieHeader(opts.binding));
  return req.send({
    ...authorizeParams(clientId),
    ...opts.overrides,
    csrf_token: opts.csrf ?? opts.binding,
    decision: opts.decision ?? 'approve',
  });
}

/** Approves on the consent screen and returns the state handed to CodeQR. */
async function startAuthorization(app: express.Express, clientId: string) {
  const { binding } = await showConsent(app, clientId);
  const response = await submitConsent(app, clientId, { binding });
  const state = new URL(response.headers.location).searchParams.get('state')!;
  return { state, binding };
}

beforeEach(() => {
  mockExchange.mockReset();
  mockExchange.mockResolvedValue({
    accessToken: 'codeqr_access_token_x',
    refreshToken: 'r_x',
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
});

describe('POST /oauth/register', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'http://localhost:6274/oauth/callback',
    'http://127.0.0.1:33418/',
    'http://[::1]:8080/callback',
    'cursor://anysphere.cursor-retrieval/oauth/user-codeqr/callback',
  ])('accepts %s', async (uri) => {
    const response = await register(makeApp(), { client_name: 'Client', redirect_uris: [uri] });

    expect(response.status).toBe(201);
  });

  it.each([
    ['plain HTTP to another machine', 'http://attacker.test/callback'],
    ['a host that only starts with localhost', 'http://localhost.attacker.test/callback'],
    ['a script URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,hi'],
    ['something that is not a URL', 'not a url'],
    ['a fragment', 'https://chatgpt.test/callback#x'],
    ['credentials that disguise the host', 'https://claude.ai@attacker.test/callback'],
    ['a non-string entry', 42],
  ])('refuses %s', async (_label, uri) => {
    const response = await register(makeApp(), { client_name: 'Client', redirect_uris: [uri] });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_redirect_uri');
  });

  it('refuses an empty list and an oversized one', async () => {
    const app = makeApp();

    const empty = await register(app, { client_name: 'Client', redirect_uris: [] });
    const many = await register(app, {
      client_name: 'Client',
      redirect_uris: Array.from({ length: 11 }, (_, i) => `https://chatgpt.test/cb${i}`),
    });

    expect(empty.status).toBe(400);
    expect(many.status).toBe(400);
  });

  it('refuses a client_name that is not a short string', async () => {
    const app = makeApp();

    const objectName = await register(app, { client_name: { a: 1 }, redirect_uris: [CLIENT_REDIRECT] });
    const longName = await register(app, { client_name: 'x'.repeat(201), redirect_uris: [CLIENT_REDIRECT] });

    expect(objectName.body.error).toBe('invalid_client_metadata');
    expect(longName.body.error).toBe('invalid_client_metadata');
  });

  it('limits registrations per address', async () => {
    const app = makeApp();
    const body = { client_name: 'Client', redirect_uris: [CLIENT_REDIRECT] };

    for (let i = 0; i < store.REGISTRATION_LIMIT; i++) {
      const ok = await request(app).post('/oauth/register').set('x-real-ip', '10.9.9.9').send(body);
      expect(ok.status).toBe(201);
    }

    const limited = await request(app).post('/oauth/register').set('x-real-ip', '10.9.9.9').send(body);
    const otherAddress = await request(app).post('/oauth/register').set('x-real-ip', '10.9.9.10').send(body);

    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(otherAddress.status).toBe(201);
  });
});

describe('GET /oauth/authorize', () => {
  it('refuses a redirect_uri the client never registered', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);

    const response = await request(app)
      .get('/oauth/authorize')
      .query({ ...authorizeParams(clientId), redirect_uri: 'https://attacker.test/steal' });

    // Must not redirect: following an unregistered URI is how an authorization
    // code gets handed to whoever asked for it.
    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.body.error).toBe('invalid_request');
  });

  it('refuses an unknown client_id', async () => {
    const response = await request(makeApp())
      .get('/oauth/authorize')
      .query(authorizeParams('codeqr_never_registered'));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_client');
  });

  it('refuses a stored registration whose redirect_uri is no longer allowed', async () => {
    // Registered before /register validated URIs.
    const client = await store.registerClient({
      clientName: 'Old',
      redirectUris: ['http://attacker.test/callback'],
    });

    const response = await request(makeApp())
      .get('/oauth/authorize')
      .query({ ...authorizeParams(client.clientId), redirect_uri: 'http://attacker.test/callback' });

    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });

  it('shows its own consent screen instead of going straight to CodeQR', async () => {
    const app = makeApp();
    const clientId = await registerClient(app, 'Totally Claude');

    const { response, binding } = await showConsent(app, clientId);

    expect(response.status).toBe(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['content-type']).toMatch(/text\/html/);
    // What CodeQR's screen cannot show: which client, and where access goes.
    expect(response.text).toContain('Totally Claude');
    expect(response.text).toContain('chatgpt.test');
    expect(response.text).toContain(`name="csrf_token" value="${binding}"`);
  });

  it('cannot be framed or cached, and sets a __Host- cookie', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);

    const { response } = await showConsent(app, clientId);
    const cookie = ([] as string[])
      .concat(response.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${BINDING_COOKIE}=`))!;

    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
  });

  it('escapes the client-supplied name', async () => {
    const app = makeApp();
    const clientId = await registerClient(app, '<img src=x onerror=alert(1)>');

    const { response } = await showConsent(app, clientId);

    expect(response.text).not.toContain('<img src=x');
    expect(response.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('vouches for a verified redirect_uri whatever name the client registered', async () => {
    const app = makeApp();
    const official = 'https://chatgpt.com/connector/oauth/fcLW7Kbi1AnJ';
    const response = await register(app, { client_name: 'Anything', redirect_uris: [official] });

    const page = await request(app)
      .get('/oauth/authorize')
      .query({ ...authorizeParams(response.body.client_id), redirect_uri: official });

    expect(page.text).toContain('<b>ChatGPT</b>');
    expect(page.text).not.toContain('Anything');
    expect(page.text).toContain('Verified by CodeQR.io');
    expect(page.text).not.toContain('has not verified');
  });

  it('tells CodeQR which verified client the signup came from, and nothing for any other', async () => {
    const approveWith = async (redirectUri: string, clientName: string) => {
      const app = makeApp();
      const { body } = await register(app, { client_name: clientName, redirect_uris: [redirectUri] });
      const page = await request(app)
        .get('/oauth/authorize')
        .query({ ...authorizeParams(body.client_id), redirect_uri: redirectUri });
      const binding = bindingFrom(page)!;
      const response = await submitConsent(app, body.client_id, {
        binding,
        overrides: { redirect_uri: redirectUri },
      });
      return new URL(response.headers.location).searchParams;
    };

    const verified = await approveWith('https://chatgpt.com/connector/oauth/fcLW7Kbi1AnJ', 'Anything');
    const borrowed = await approveWith('https://chatgpt.com/connector/oauth/someoneElse', 'ChatGPT');

    expect(verified.get('mcp_client')).toBe('chatgpt');
    expect(borrowed.has('mcp_client')).toBe(false);
    expect(borrowed.get('state')).toBeTruthy();
  });

  it('does not vouch for a client that only borrows a verified name', async () => {
    // Same name, same host, another ChatGPT connector: the code would go to
    // whoever owns that connector, not to CodeQR's app.
    const app = makeApp();
    const other = 'https://chatgpt.com/connector/oauth/someoneElse';
    const response = await register(app, { client_name: 'ChatGPT', redirect_uris: [other] });

    const page = await request(app)
      .get('/oauth/authorize')
      .query({ ...authorizeParams(response.body.client_id), redirect_uri: other });

    expect(page.text).toContain('has not verified');
    expect(page.text).not.toContain('Verified by CodeQR.io');
  });

  it('keeps the browser’s existing binding so parallel sign-ins do not clash', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { binding } = await showConsent(app, clientId);

    const again = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookieHeader(binding))
      .query(authorizeParams(clientId));

    expect(bindingFrom(again)).toBe(binding);
  });

  it('reports a bad response_type to the client, not as a dead-end page', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);

    const response = await request(app)
      .get('/oauth/authorize')
      .query({ ...authorizeParams(clientId), response_type: 'token' });

    expect(response.status).toBe(302);
    const target = new URL(response.headers.location);
    expect(target.origin).toBe('https://chatgpt.test');
    expect(target.searchParams.get('error')).toBe('unsupported_response_type');
    expect(target.searchParams.get('state')).toBe('client-state-1');
  });
});

describe('POST /oauth/authorize', () => {
  it('refuses an approval posted without the consent cookie', async () => {
    // What a form on another site, auto-submitted in the user's browser, looks
    // like: SameSite=Lax keeps the cookie off it.
    const app = makeApp();
    const clientId = await registerClient(app);
    const { binding } = await showConsent(app, clientId);

    const response = await submitConsent(app, clientId, { csrf: binding });

    expect(response.status).toBe(403);
    expect(response.headers.location).toBeUndefined();
  });

  it('refuses an approval whose token does not match the cookie', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { binding } = await showConsent(app, clientId);

    const response = await submitConsent(app, clientId, { binding, csrf: 'x'.repeat(32) });

    expect(response.status).toBe(403);
    expect(response.headers.location).toBeUndefined();
  });

  it('re-validates the request instead of trusting the form', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { binding } = await showConsent(app, clientId);

    const response = await submitConsent(app, clientId, {
      binding,
      overrides: { redirect_uri: 'https://attacker.test/steal' },
    });

    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });

  it('sends the user to CodeQR on approval without leaking the client’s state', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { binding } = await showConsent(app, clientId);

    const response = await submitConsent(app, clientId, { binding });

    expect(response.status).toBe(303);
    const target = new URL(response.headers.location);
    expect(target.origin + target.pathname).toBe('https://app.example.test/oauth/authorize');
    // The client's own state stays on this server; forwarding it would let a
    // callback carrying it be replayed into the session.
    expect(target.searchParams.get('state')).not.toBe('client-state-1');
  });

  it('tells the client when the user cancels', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { binding } = await showConsent(app, clientId);

    const response = await submitConsent(app, clientId, { binding, decision: 'deny' });

    expect(response.status).toBe(303);
    const target = new URL(response.headers.location);
    expect(target.origin + target.pathname).toBe('https://chatgpt.test/callback');
    expect(target.searchParams.get('error')).toBe('access_denied');
    expect(target.searchParams.get('state')).toBe('client-state-1');
  });
});

describe('GET /oauth/callback', () => {
  it('does not complete in a browser that never saw the consent screen', async () => {
    // The reported attack: approve your own client, keep the CodeQR URL it
    // redirects to, and send that link to a victim. Their callback carries no
    // consent cookie, so no code goes to the attacker's redirect_uri.
    const app = makeApp();
    const clientId = await registerClient(app, 'Totally Claude');
    const { state } = await startAuthorization(app, clientId);

    const response = await request(app).get('/oauth/callback').query({ code: 'victim-code', state });

    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('does not complete in a different browser that has its own binding', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { state } = await startAuthorization(app, clientId);
    const { binding: otherBrowser } = await showConsent(app, clientId);

    const response = await request(app)
      .get('/oauth/callback')
      .set('Cookie', cookieHeader(otherBrowser))
      .query({ code: 'c', state });

    expect(response.status).toBe(400);
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('tells the client when the user refuses, instead of leaving it waiting', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { state, binding } = await startAuthorization(app, clientId);

    const response = await request(app)
      .get('/oauth/callback')
      .set('Cookie', cookieHeader(binding))
      .query({ error: 'access_denied', error_description: 'User refused', state });

    expect(response.status).toBe(302);
    const target = new URL(response.headers.location);
    expect(target.origin + target.pathname).toBe('https://chatgpt.test/callback');
    expect(target.searchParams.get('error')).toBe('access_denied');
    expect(target.searchParams.get('state')).toBe('client-state-1');
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('hands the client a code and its original state on approval', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { state, binding } = await startAuthorization(app, clientId);

    const response = await request(app)
      .get('/oauth/callback')
      .set('Cookie', cookieHeader(binding))
      .query({ code: 'codeqr-code', state });

    const target = new URL(response.headers.location);
    expect(target.searchParams.get('code')).toBeTruthy();
    expect(target.searchParams.get('state')).toBe('client-state-1');
    expect(target.searchParams.get('error')).toBeNull();
  });

  it('rejects a state it never issued', async () => {
    const response = await request(makeApp())
      .get('/oauth/callback')
      .query({ code: 'x', state: 'forged' });

    expect(response.status).toBe(400);
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('refuses to replay a state that was already used', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { state, binding } = await startAuthorization(app, clientId);

    await request(app).get('/oauth/callback').set('Cookie', cookieHeader(binding)).query({ code: 'first', state });
    const replay = await request(app)
      .get('/oauth/callback')
      .set('Cookie', cookieHeader(binding))
      .query({ code: 'second', state });

    expect(replay.status).toBe(400);
    expect(mockExchange).toHaveBeenCalledTimes(1);
  });

  it('reports a failed exchange to the client rather than a blank page', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const { state, binding } = await startAuthorization(app, clientId);
    mockExchange.mockRejectedValue(new Error('CodeQR rejected the token request'));

    const response = await request(app)
      .get('/oauth/callback')
      .set('Cookie', cookieHeader(binding))
      .query({ code: 'c', state });

    const target = new URL(response.headers.location);
    expect(target.origin + target.pathname).toBe('https://chatgpt.test/callback');
    expect(target.searchParams.get('error')).toBe('server_error');
  });
});
