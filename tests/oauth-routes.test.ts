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

vi.mock('../src/oauth/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/oauth/store.js')>();
  return { ...actual, saveRememberedConsent: vi.fn(actual.saveRememberedConsent) };
});

const { exchangeCodeForCredentials } = await import('../src/oauth/codeqr-oauth.js');
const { createOAuthRouter } = await import('../src/routes/oauth.js');
const store = await import('../src/oauth/store.js');
const { BINDING_COOKIE } = await import('../src/oauth/browser-binding.js');
const { REMEMBER_COOKIE, scopeVersion } = await import('../src/oauth/remembered-consent.js');
const { PRIVACY_URL, TERMS_URL } = await import('../src/oauth/consent-page.js');

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
  vi.mocked(store.saveRememberedConsent).mockClear();
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

  it('tells CodeQR which client the signup came from, by where its redirect URI points', async () => {
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
    const claude = await approveWith('https://claude.ai/api/mcp/auth_callback', 'Claude');
    const unknown = await approveWith('https://attacker.test/callback', 'ChatGPT');

    expect(verified.get('mcp_client')).toBe('chatgpt');
    expect(claude.get('mcp_client')).toBe('claude');
    expect(unknown.get('mcp_client')).toBe('other');
    expect(unknown.get('state')).toBeTruthy();
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

describe('consent screen language', () => {
  async function screenIn(acceptLanguage: string | undefined, clientName = 'Test Client') {
    const app = makeApp();
    const clientId = await registerClient(app, clientName);
    const req = request(app).get('/oauth/authorize');
    if (acceptLanguage !== undefined) req.set('Accept-Language', acceptLanguage);
    return req.query(authorizeParams(clientId));
  }

  it('speaks Brazilian Portuguese to pt-BR,pt;q=0.9', async () => {
    const page = await screenIn('pt-BR,pt;q=0.9');

    expect(page.text).toContain('<html lang="pt-br">');
    expect(page.text).toContain('Conceder permissões:');
    expect(page.text).toContain('O que acontece a seguir');
    expect(page.text).toContain('A CodeQR.io não verificou este aplicativo.');
    expect(page.text).not.toContain('Grant permissions:');
  });

  it('speaks Japanese to ja', async () => {
    const page = await screenIn('ja');

    expect(page.text).toContain('<html lang="ja">');
    expect(page.text).toContain('権限を付与：');
    expect(page.text).not.toContain('Grant permissions:');
  });

  it.each([['xx'], [undefined]])('falls back to English for %s', async (acceptLanguage) => {
    const page = await screenIn(acceptLanguage);

    expect(page.text).toContain('<html lang="en">');
    expect(page.text).toContain('Grant permissions:');
    expect(page.text).toContain('What happens next');
  });

  it('follows q-values over the order of the header', async () => {
    const page = await screenIn('en;q=0.4, de;q=0.9');

    expect(page.text).toContain('<html lang="de">');
    expect(page.text).toContain('Berechtigungen erteilen:');
  });

  it('still escapes the client-supplied name outside English', async () => {
    const page = await screenIn('pt-BR', '<img src=x onerror=alert(1)>');

    expect(page.text).toContain('<html lang="pt-br">');
    expect(page.text).not.toContain('<img src=x');
    expect(page.text).toContain('<b>&lt;img src=x onerror=alert(1)&gt;</b>');
  });

  it('keeps the same CSP and security headers in every language', async () => {
    for (const acceptLanguage of ['en', 'ja', 'pt-PT', 'ru']) {
      const page = await screenIn(acceptLanguage);

      expect(page.headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
      );
      expect(page.headers['x-frame-options']).toBe('DENY');
      expect(page.headers['x-content-type-options']).toBe('nosniff');
      expect(page.headers['referrer-policy']).toBe('no-referrer');
      expect(page.headers['cache-control']).toBe('no-store');
    }
  });

  it('links the privacy policy and the terms in a new tab, without a referrer', async () => {
    const page = await screenIn('fr');

    for (const url of [PRIVACY_URL, TERMS_URL]) {
      expect(page.text).toContain(`<a href="${url}" target="_blank" rel="noopener noreferrer">`);
    }
    expect(page.text).toContain('Politique de confidentialité');
    expect(page.text).toContain("Conditions d'utilisation");
  });

  it('runs no script and loads every image from a data: URI', async () => {
    const page = await screenIn('ko');
    const sources = [...page.text.matchAll(/\ssrc="([^"]*)"/g)].map((match) => match[1]);

    expect(page.text).not.toMatch(/<script/i);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((src) => src.startsWith('data:'))).toBe(true);
  });
});

describe('remembered consent', () => {
  const VERIFIED_REDIRECT = 'https://chatgpt.com/connector/oauth/fcLW7Kbi1AnJ';
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const REFUSALS: Array<[string, Record<string, string>]> = [
    ['refuses on CodeQR', { error: 'access_denied', error_description: 'User refused' }],
    ['comes back from CodeQR with another error', { error: 'server_error' }],
    ['comes back from CodeQR without a code', {}],
  ];

  function setCookieFor(response: request.Response, name: string) {
    return ([] as string[]).concat(response.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  }

  function cookieValue(response: request.Response, name: string) {
    return setCookieFor(response, name)?.slice(name.length + 1).split(';')[0];
  }

  const rememberHeader = (id: string) => `${REMEMBER_COOKIE}=${id}`;

  /** Keeps what the server sets and drops what it clears, as a browser would. */
  function browser(app: express.Express) {
    const jar = new Map<string, string>();

    const absorb = (response: request.Response) => {
      for (const header of ([] as string[]).concat(response.headers['set-cookie'] ?? [])) {
        const [pair = '', ...attributes] = header.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const expired = attributes.some((attribute) => {
          const [key = '', raw = ''] = attribute.split('=');
          const lower = key.trim().toLowerCase();
          return (lower === 'max-age' && Number(raw) <= 0) || (lower === 'expires' && Date.parse(raw) <= Date.now());
        });
        if (expired || value === '') jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };

    const send = async (req: request.Test) =>
      absorb(await req.set('Cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; ')));

    return {
      get: (name: string) => jar.get(name),
      visit: (params: Record<string, string>) => send(request(app).get('/oauth/authorize').query(params)),
      decide: (params: Record<string, string>, decision = 'approve') =>
        send(
          request(app)
            .post('/oauth/authorize')
            .type('form')
            .send({ ...params, csrf_token: jar.get(BINDING_COOKIE), decision }),
        ),
      returnFromCodeQR: (toCodeQR: request.Response, query: Record<string, string>) =>
        send(
          request(app)
            .get('/oauth/callback')
            .query({ ...query, state: new URL(toCodeQR.headers.location).searchParams.get('state')! }),
        ),
    };
  }

  async function registerVerified(app: express.Express) {
    const { body } = await register(app, {
      client_name: 'ChatGPT',
      redirect_uris: [VERIFIED_REDIRECT, CLIENT_REDIRECT],
    });
    return body.client_id as string;
  }

  function paramsFor(clientId: string, overrides: Record<string, string> = {}) {
    return { ...authorizeParams(clientId), redirect_uri: VERIFIED_REDIRECT, ...overrides };
  }

  /** Screen, Continue, and a code back from CodeQR. */
  async function connect(b: ReturnType<typeof browser>, params: Record<string, string>) {
    expect((await b.visit(params)).status).toBe(200);
    const approved = await b.decide(params);
    expect(approved.status).toBe(303);
    const callback = await b.returnFromCodeQR(approved, { code: 'codeqr-code' });
    expect(callback.status).toBe(302);
    return callback;
  }

  async function rememberedId(app: express.Express, params: Record<string, string>) {
    const b = browser(app);
    await connect(b, params);
    return b.get(REMEMBER_COOKIE)!;
  }

  function comeBack(app: express.Express, params: Record<string, string>, cookies: string[]) {
    return request(app).get('/oauth/authorize').set('Cookie', cookies.join('; ')).query(params);
  }

  it('remembers an approval of the verified client only once the connection completes', async () => {
    const app = makeApp();
    const clientId = await registerVerified(app);
    const b = browser(app);

    await b.visit(paramsFor(clientId));
    const approved = await b.decide(paramsFor(clientId));

    expect(approved.status).toBe(303);
    expect(setCookieFor(approved, REMEMBER_COOKIE)).toBeUndefined();
    expect(store.saveRememberedConsent).not.toHaveBeenCalled();

    const callback = await b.returnFromCodeQR(approved, { code: 'codeqr-code' });
    const cookie = setCookieFor(callback, REMEMBER_COOKIE)!;
    const id = cookieValue(callback, REMEMBER_COOKIE)!;

    expect(callback.status).toBe(302);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toContain(`Max-Age=${store.REMEMBERED_CONSENT_TTL_SEC}`);
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await store.getRememberedConsent(id)).toMatchObject({
      clientId,
      redirectUri: VERIFIED_REDIRECT,
      scopeVersion: scopeVersion('mcp:tools'),
    });
    expect((await b.visit(paramsFor(clientId))).status).toBe(303);
  });

  it.each(REFUSALS)('remembers nothing when the user continues and then %s', async (_label, query) => {
    const app = makeApp();
    const clientId = await registerVerified(app);
    const b = browser(app);

    await b.visit(paramsFor(clientId));
    const approved = await b.decide(paramsFor(clientId));
    const back = await b.returnFromCodeQR(approved, query);

    expect(back.status).toBe(302);
    expect(new URL(back.headers.location).searchParams.get('error')).toBeTruthy();
    expect(b.get(REMEMBER_COOKIE)).toBeUndefined();
    expect(store.saveRememberedConsent).not.toHaveBeenCalled();
    expect((await b.visit(paramsFor(clientId))).status).toBe(200);
  });

  it.each(REFUSALS)('forgets an earlier approval when this browser later %s', async (_label, query) => {
    const app = makeApp();
    const clientId = await registerVerified(app);
    const b = browser(app);
    await connect(b, paramsFor(clientId));
    const id = b.get(REMEMBER_COOKIE)!;

    const skipped = await b.visit(paramsFor(clientId));
    expect(skipped.status).toBe(303);
    const refused = await b.returnFromCodeQR(skipped, query);

    expect(setCookieFor(refused, REMEMBER_COOKIE)).toBeDefined();
    expect(b.get(REMEMBER_COOKIE)).toBeUndefined();
    expect(await store.getRememberedConsent(id)).toBeNull();
    expect((await b.visit(paramsFor(clientId))).status).toBe(200);
  });

  it('does not extend the approval when a re-entry that skipped the screen completes', async () => {
    const app = makeApp();
    const clientId = await registerVerified(app);
    const b = browser(app);
    await connect(b, paramsFor(clientId));
    const id = b.get(REMEMBER_COOKIE)!;
    const { expiresAt } = (await store.getRememberedConsent(id))!;
    vi.mocked(store.saveRememberedConsent).mockClear();

    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ONE_DAY_MS);
    try {
      const skipped = await b.visit(paramsFor(clientId));
      expect(skipped.status).toBe(303);
      const callback = await b.returnFromCodeQR(skipped, { code: 'codeqr-code' });

      expect(callback.status).toBe(302);
      expect(setCookieFor(callback, REMEMBER_COOKIE)).toBeUndefined();
      expect(store.saveRememberedConsent).not.toHaveBeenCalled();
      expect((await store.getRememberedConsent(id))!.expiresAt).toBe(expiresAt);
    } finally {
      clock.mockRestore();
    }
  });

  it('skips the screen for the same client, redirect_uri and scope, and the callback completes in this browser', async () => {
    const app = makeApp();
    const clientId = await registerVerified(app);
    const b = browser(app);
    await connect(b, paramsFor(clientId));

    const back = await b.visit(paramsFor(clientId));

    expect(back.status).toBe(303);
    expect(back.headers['cache-control']).toBe('no-store');
    const target = new URL(back.headers.location);
    expect(target.origin + target.pathname).toBe('https://app.example.test/oauth/authorize');
    expect(target.searchParams.get('mcp_client')).toBe('chatgpt');

    const callback = await b.returnFromCodeQR(back, { code: 'codeqr-code' });

    expect(callback.status).toBe(302);
    const delivered = new URL(callback.headers.location);
    expect(delivered.origin + delivered.pathname).toBe(VERIFIED_REDIRECT);
    expect(delivered.searchParams.get('code')).toBeTruthy();
    expect(delivered.searchParams.get('state')).toBe('client-state-1');
  });

  it('does not complete a skipped screen in a browser without its binding', async () => {
    const app = makeApp();
    const clientId = await registerVerified(app);
    const id = await rememberedId(app, paramsFor(clientId));
    mockExchange.mockClear();

    const back = await comeBack(app, paramsFor(clientId), [rememberHeader(id)]);
    const binding = bindingFrom(back)!;
    expect(binding).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const state = new URL(back.headers.location).searchParams.get('state')!;
    const elsewhere = await request(app).get('/oauth/callback').query({ code: 'c', state });

    const backAgain = await comeBack(app, paramsFor(clientId), [rememberHeader(id)]);
    const stateAgain = new URL(backAgain.headers.location).searchParams.get('state')!;
    const { binding: otherBrowser } = await showConsent(app, clientId);
    const withOtherBinding = await request(app)
      .get('/oauth/callback')
      .set('Cookie', cookieHeader(otherBrowser))
      .query({ code: 'c', state: stateAgain });

    for (const response of [elsewhere, withOtherBinding]) {
      expect(response.status).toBe(400);
      expect(response.headers.location).toBeUndefined();
      expect(response.body.error_description).toMatch(/not started in this browser/);
    }
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('shows the screen again for another redirect_uri, another scope or another client', async () => {
    const app = makeApp();
    const clientId = await registerVerified(app);
    const id = await rememberedId(app, paramsFor(clientId));
    const otherClient = await registerVerified(app);

    const otherRedirect = await comeBack(app, paramsFor(clientId, { redirect_uri: CLIENT_REDIRECT }), [
      rememberHeader(id),
    ]);
    const otherScope = await comeBack(app, paramsFor(clientId, { scope: 'mcp:tools mcp:admin' }), [
      rememberHeader(id),
    ]);
    const otherClientBack = await comeBack(app, paramsFor(otherClient), [rememberHeader(id)]);

    for (const response of [otherRedirect, otherScope, otherClientBack]) {
      expect(response.status).toBe(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.text).toContain('name="decision" value="approve"');
    }
  });

  it('versions the scope by both the requested scope and the CodeQR scope list', () => {
    expect(scopeVersion('mcp:tools')).toBe(scopeVersion('mcp:tools'));
    expect(scopeVersion('mcp:tools mcp:admin')).not.toBe(scopeVersion('mcp:tools'));
    expect(scopeVersion('mcp:tools', ['links.read'])).not.toBe(scopeVersion('mcp:tools', ['links.read', 'links.write']));
  });

  it('still validates the request before skipping the screen', async () => {
    const app = makeApp();
    const clientId = await registerVerified(app);
    const id = await rememberedId(app, paramsFor(clientId));

    const badType = await comeBack(app, paramsFor(clientId, { response_type: 'token' }), [rememberHeader(id)]);
    const noPkce = await comeBack(app, paramsFor(clientId, { code_challenge_method: 'plain' }), [rememberHeader(id)]);

    expect(new URL(badType.headers.location).searchParams.get('error')).toBe('unsupported_response_type');
    expect(new URL(noPkce.headers.location).searchParams.get('error')).toBe('invalid_request');
    for (const response of [badType, noPkce]) {
      expect(response.status).toBe(302);
      expect(new URL(response.headers.location).origin).toBe('https://chatgpt.com');
    }
  });

  it('remembers neither an unverified client nor a refusal on this screen', async () => {
    const app = makeApp();
    const unverified = await registerClient(app, 'ChatGPT');
    const verified = await registerVerified(app);

    const connectedUnverified = browser(app);
    await connect(connectedUnverified, authorizeParams(unverified));
    const refusedHere = browser(app);
    await refusedHere.visit(paramsFor(verified));
    const refused = await refusedHere.decide(paramsFor(verified), 'deny');

    expect(refused.status).toBe(303);
    expect(new URL(refused.headers.location).searchParams.get('error')).toBe('access_denied');
    expect(connectedUnverified.get(REMEMBER_COOKIE)).toBeUndefined();
    expect(refusedHere.get(REMEMBER_COOKIE)).toBeUndefined();
    expect(store.saveRememberedConsent).not.toHaveBeenCalled();
  });

  it.each([
    ['a well-formed id this server never issued', 'f'.repeat(32)],
    ['a value of the wrong length', 'short'],
    ['a value outside the cookie alphabet', `${'a'.repeat(31)}!`],
  ])('shows the screen for %s', async (_label, value) => {
    const app = makeApp();
    const clientId = await registerVerified(app);
    await rememberedId(app, paramsFor(clientId));

    const back = await comeBack(app, paramsFor(clientId), [rememberHeader(value)]);

    expect(back.status).toBe(200);
  });

  it('shows the screen once the remembered approval has expired', async () => {
    const app = makeApp();
    const clientId = await registerVerified(app);
    const id = await rememberedId(app, paramsFor(clientId));

    const later = Date.now() + (store.REMEMBERED_CONSENT_TTL_SEC + 1) * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      const back = await comeBack(app, paramsFor(clientId), [rememberHeader(id)]);
      expect(back.status).toBe(200);
      expect(await store.getRememberedConsent(id)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('shows the screen for a record whose redirect_uri is not verified', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const id = 'r'.repeat(32);
    await store.saveRememberedConsent(id, {
      clientId,
      redirectUri: CLIENT_REDIRECT,
      scopeVersion: scopeVersion('mcp:tools'),
    });

    const back = await comeBack(app, authorizeParams(clientId), [rememberHeader(id)]);

    expect(back.status).toBe(200);
  });

  it('shows the screen when the record was for another redirect_uri of the same client', async () => {
    const app = makeApp();
    const clientId = await registerVerified(app);
    const id = 's'.repeat(32);
    await store.saveRememberedConsent(id, {
      clientId,
      redirectUri: CLIENT_REDIRECT,
      scopeVersion: scopeVersion('mcp:tools'),
    });

    const back = await comeBack(app, paramsFor(clientId), [rememberHeader(id)]);

    expect(back.status).toBe(200);
  });

  it('replaces the remembered id on every completed approval and forgets the previous one', async () => {
    const app = makeApp();
    const clientId = await registerVerified(app);
    const b = browser(app);
    await connect(b, paramsFor(clientId));
    const first = b.get(REMEMBER_COOKIE)!;

    // A new scope brings the screen back while the browser still holds the old cookie.
    const params = paramsFor(clientId, { scope: 'mcp:tools mcp:admin' });
    await connect(b, params);
    const second = b.get(REMEMBER_COOKIE)!;

    expect(second).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second).not.toBe(first);
    expect(await store.getRememberedConsent(first)).toBeNull();
    expect((await b.visit(params)).status).toBe(303);
  });
});

describe('GET /oauth/callback on mobile', () => {
  const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
  const DESKTOP_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
  const VERIFIED_REDIRECT = 'https://chatgpt.com/connector/oauth/fcLW7Kbi1AnJ';

  function loggedEvents(spy: { mock: { calls: unknown[][] } }) {
    return spy.mock.calls
      .map(([chunk]) => {
        try {
          return JSON.parse(String(chunk)) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry?.event === 'oauth.callback');
  }

  /** A fresh authorization, answered by CodeQR with `query`, from a browser with the given headers. */
  async function callbackWith(
    query: Record<string, string>,
    headers: Record<string, string>,
    redirectUri = CLIENT_REDIRECT,
  ) {
    const app = makeApp();
    const { body } = await register(app, { client_name: 'Test Client', redirect_uris: [redirectUri] });
    const params = { ...authorizeParams(body.client_id), redirect_uri: redirectUri };
    const consent = await request(app).get('/oauth/authorize').query(params);
    const binding = bindingFrom(consent)!;
    const approved = await request(app)
      .post('/oauth/authorize')
      .type('form')
      .set('Cookie', cookieHeader(binding))
      .send({ ...params, csrf_token: binding, decision: 'approve' });
    const state = new URL(approved.headers.location).searchParams.get('state')!;

    return request(app)
      .get('/oauth/callback')
      .set('Cookie', cookieHeader(binding))
      .set(headers)
      .query({ ...query, state });
  }

  function handoffHref(response: request.Response): string {
    const match = /<a class="button" href="([^"]*)"/.exec(response.text);
    return match![1]!.replaceAll('&amp;', '&');
  }

  /** The two callbacks differ in their state, which is random; the URL they lead to is otherwise the same. */
  function withoutCode(url: string) {
    const target = new URL(url);
    target.searchParams.delete('code');
    return target.toString();
  }

  it('ends the connection on a page whose link is the exact URL desktop is redirected to', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const desktop = await callbackWith({ code: 'codeqr-code' }, { 'User-Agent': DESKTOP_UA });
      const mobile = await callbackWith({ code: 'codeqr-code' }, { 'User-Agent': ANDROID_UA });

      expect(desktop.status).toBe(302);
      expect(mobile.status).toBe(200);
      expect(mobile.headers.location).toBeUndefined();
      expect(mobile.headers['content-type']).toMatch(/text\/html/);
      expect(mobile.headers['content-security-policy']).toContain("default-src 'none'");
      expect(mobile.headers['x-frame-options']).toBe('DENY');
      expect(mobile.headers['x-content-type-options']).toBe('nosniff');
      expect(mobile.headers['referrer-policy']).toBe('no-referrer');
      expect(mobile.headers['cache-control']).toBe('no-store');
      expect(mobile.text).not.toMatch(/<script|http-equiv/i);

      const target = new URL(handoffHref(mobile));
      expect(target.origin + target.pathname).toBe(CLIENT_REDIRECT);
      expect(target.searchParams.get('code')).toBeTruthy();
      expect(target.searchParams.get('state')).toBe('client-state-1');
      expect(withoutCode(handoffHref(mobile))).toBe(withoutCode(desktop.headers.location));
      expect(mobile.text).toContain('Connected to CodeQR. Tap to go back to your app.');

      const [desktopLog, mobileLog] = [loggedEvents(stdout).at(-2), loggedEvents(stdout).at(-1)];
      expect(desktopLog).toMatchObject({ outcome: 'ok' });
      expect(desktopLog).not.toHaveProperty('mobileHandoff');
      expect(mobileLog).toMatchObject({ outcome: 'ok', mobileHandoff: true });
    } finally {
      stdout.mockRestore();
    }
  });

  it('escapes the ampersands in the link and keeps the URL intact', async () => {
    const response = await callbackWith({ code: 'codeqr-code' }, { 'User-Agent': ANDROID_UA });

    expect(response.text).toMatch(/href="[^"]*code=[^"]*&amp;state=client-state-1"/);
    expect(response.text).not.toMatch(/href="[^"]*&state=/);
  });

  it('names a verified client and shows its logo', async () => {
    const response = await callbackWith(
      { code: 'codeqr-code' },
      { 'User-Agent': ANDROID_UA },
      VERIFIED_REDIRECT,
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('Connected to CodeQR. Tap to go back to ChatGPT.');
    expect(response.text).toContain('class="client-logo"');
    expect(handoffHref(response)).toMatch(/^https:\/\/chatgpt\.com\/connector\/oauth\/fcLW7Kbi1AnJ\?code=/);
  });

  it('speaks the language of Accept-Language', async () => {
    const response = await callbackWith(
      { code: 'codeqr-code' },
      { 'User-Agent': ANDROID_UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    );

    expect(response.text).toContain('<html lang="pt-br">');
    expect(response.text).toContain('Conectado à CodeQR. Toque para voltar ao seu app.');
  });

  it('keeps the remembered-consent cookie behaviour of the redirect', async () => {
    const app = makeApp();
    const { body } = await register(app, { client_name: 'ChatGPT', redirect_uris: [VERIFIED_REDIRECT] });
    const params = { ...authorizeParams(body.client_id), redirect_uri: VERIFIED_REDIRECT };
    const consent = await request(app).get('/oauth/authorize').query(params);
    const binding = bindingFrom(consent)!;
    const approved = await request(app)
      .post('/oauth/authorize')
      .type('form')
      .set('Cookie', cookieHeader(binding))
      .send({ ...params, csrf_token: binding, decision: 'approve' });
    const state = new URL(approved.headers.location).searchParams.get('state')!;

    const mobile = await request(app)
      .get('/oauth/callback')
      .set('Cookie', cookieHeader(binding))
      .set('User-Agent', ANDROID_UA)
      .query({ code: 'codeqr-code', state });

    expect(mobile.status).toBe(200);
    const cookie = ([] as string[])
      .concat(mobile.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${REMEMBER_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toContain(`Max-Age=${store.REMEMBERED_CONSENT_TTL_SEC}`);
  });

  it('hands an error from CodeQR back with the same tap, and desktop still redirects', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const query = { error: 'access_denied', error_description: 'User refused' };
      const desktop = await callbackWith(query, { 'User-Agent': DESKTOP_UA });
      const mobile = await callbackWith(query, { 'User-Agent': ANDROID_UA });

      expect(desktop.status).toBe(302);
      expect(mobile.status).toBe(200);
      expect(mobile.text).toContain('The connection was not completed. Tap to go back to your app.');

      const target = new URL(handoffHref(mobile));
      expect(target.origin + target.pathname).toBe(CLIENT_REDIRECT);
      expect(target.searchParams.get('error')).toBe('access_denied');
      expect(target.searchParams.get('error_description')).toBe('User refused');
      expect(target.searchParams.get('state')).toBe('client-state-1');
      expect(target.searchParams.get('code')).toBeNull();
      expect(handoffHref(mobile)).toBe(desktop.headers.location);
      expect(mockExchange).not.toHaveBeenCalled();
      expect(loggedEvents(stdout).at(-1)).toMatchObject({ reason: 'codeqr_access_denied', mobileHandoff: true });
    } finally {
      stdout.mockRestore();
    }
  });

  it('hands a failed token exchange back the same way', async () => {
    mockExchange.mockRejectedValueOnce(new Error('exchange blew up'));

    const response = await callbackWith({ code: 'codeqr-code' }, { 'User-Agent': ANDROID_UA });

    expect(response.status).toBe(200);
    const target = new URL(handoffHref(response));
    expect(target.searchParams.get('error')).toBe('server_error');
    expect(target.searchParams.get('state')).toBe('client-state-1');
  });
});
