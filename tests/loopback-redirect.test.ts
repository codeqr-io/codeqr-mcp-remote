import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const { isRegisteredRedirectUri } = await import('../src/oauth/redirect-uri.js');

const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130 Safari/537.36';

let addressCounter = 0;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/oauth', createOAuthRouter());
  return app;
}

async function registerLoopbackClient(app: express.Express, redirectUri: string) {
  addressCounter += 1;
  const response = await request(app)
    .post('/oauth/register')
    .set('x-real-ip', `10.9.0.${addressCounter}`)
    .send({ client_name: 'Claude Code', redirect_uris: [redirectUri] });
  return response.body.client_id as string;
}

function authorizeParams(clientId: string, redirectUri: string) {
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'client-state',
  };
}

function bindingFrom(response: request.Response): string {
  const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  return cookies.find((c) => c.startsWith(`${BINDING_COOKIE}=`))!.slice(BINDING_COOKIE.length + 1).split(';')[0]!;
}

beforeEach(() => {
  vi.mocked(exchangeCodeForCredentials).mockReset();
  vi.mocked(exchangeCodeForCredentials).mockResolvedValue({
    accessToken: 'codeqr_access_token_x',
    refreshToken: 'r_x',
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
});

describe('loopback redirect on another port', () => {
  it('completes sign-in and token exchange on the port the session listens on', async () => {
    const app = makeApp();
    const clientId = await registerLoopbackClient(app, 'http://127.0.0.1:51450/callback');
    const sessionRedirect = 'http://127.0.0.1:62011/callback';

    const consent = await request(app).get('/oauth/authorize').query(authorizeParams(clientId, sessionRedirect));
    expect(consent.status).toBe(200);
    const binding = bindingFrom(consent);

    const approved = await request(app)
      .post('/oauth/authorize')
      .type('form')
      .set('Cookie', `${BINDING_COOKIE}=${binding}`)
      .send({ ...authorizeParams(clientId, sessionRedirect), csrf_token: binding, decision: 'approve' });
    const brokerState = new URL(approved.headers.location).searchParams.get('state')!;

    const callback = await request(app)
      .get('/oauth/callback')
      .set('User-Agent', DESKTOP)
      .set('Cookie', `${BINDING_COOKIE}=${binding}`)
      .query({ code: 'codeqr-code', state: brokerState });
    const back = new URL(callback.headers.location);
    expect(`${back.origin}${back.pathname}`).toBe(sessionRedirect);

    const token = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code'),
      redirect_uri: sessionRedirect,
      client_id: clientId,
      code_verifier: VERIFIER,
    });
    expect(token.status).toBe(200);
    expect(token.body.access_token).toEqual(expect.any(String));
  });

  it.each([
    ['another loopback host', 'http://localhost:62011/callback'],
    ['another path', 'http://127.0.0.1:62011/other'],
  ])('still refuses %s', async (_case, requested) => {
    const app = makeApp();
    const clientId = await registerLoopbackClient(app, 'http://127.0.0.1:51450/callback');

    const response = await request(app).get('/oauth/authorize').query(authorizeParams(clientId, requested));

    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });
});

describe('isRegisteredRedirectUri', () => {
  it('ignores the port only for loopback http', () => {
    expect(isRegisteredRedirectUri(['http://localhost:3118/callback'], 'http://localhost:4000/callback')).toBe(true);
    expect(isRegisteredRedirectUri(['http://[::1]:3118/callback'], 'http://[::1]/callback')).toBe(true);
    expect(isRegisteredRedirectUri(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isRegisteredRedirectUri(['https://app.test:8443/cb'], 'https://app.test:9443/cb')).toBe(false);
    expect(isRegisteredRedirectUri(['http://127.0.0.1:3118/callback?x=1'], 'http://127.0.0.1:4000/callback?x=2')).toBe(false);
  });
});
