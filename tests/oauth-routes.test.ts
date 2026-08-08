import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These cover the three fixes this change claims and the review found untested:
 * redirect_uri validation, the refusal path, and state handling on the callback.
 *
 * Every one of them fails open — deleting the redirect_uri check, or dropping
 * the error branch in the callback, breaks nothing that any other test watches.
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

const mockExchange = vi.mocked(exchangeCodeForCredentials);

const CLIENT_REDIRECT = 'https://chatgpt.test/callback';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/oauth', createOAuthRouter());
  return app;
}

async function registerClient(app: express.Express) {
  const response = await request(app)
    .post('/oauth/register')
    .send({ client_name: 'Test Client', redirect_uris: [CLIENT_REDIRECT] });
  return response.body.client_id as string;
}

/** Drives /oauth/authorize and returns the state handed to CodeQR. */
async function startAuthorization(app: express.Express, clientId: string) {
  const response = await request(app).get('/oauth/authorize').query({
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    response_type: 'code',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'client-state-1',
  });

  return new URL(response.headers.location).searchParams.get('state')!;
}

beforeEach(() => {
  mockExchange.mockReset();
  mockExchange.mockResolvedValue({
    accessToken: 'codeqr_access_token_x',
    refreshToken: 'r_x',
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
});

describe('GET /oauth/authorize', () => {
  it('refuses a redirect_uri the client never registered', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);

    const response = await request(app).get('/oauth/authorize').query({
      client_id: clientId,
      redirect_uri: 'https://attacker.test/steal',
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    });

    // Must not redirect: following an unregistered URI is how an authorization
    // code gets handed to whoever asked for it.
    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.body.error).toBe('invalid_request');
  });

  it('refuses an unknown client_id', async () => {
    const response = await request(makeApp()).get('/oauth/authorize').query({
      client_id: 'codeqr_never_registered',
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_client');
  });

  it('sends the user to CodeQR without leaking the client’s state', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);

    const response = await request(app).get('/oauth/authorize').query({
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      state: 'client-state-1',
    });

    expect(response.status).toBe(302);
    const target = new URL(response.headers.location);
    expect(target.origin + target.pathname).toBe('https://app.example.test/oauth/authorize');
    // The client's own state stays on this server; forwarding it would let a
    // callback carrying it be replayed into the session.
    expect(target.searchParams.get('state')).not.toBe('client-state-1');
  });

  it('reports a bad response_type to the client, not as a dead-end page', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);

    const response = await request(app).get('/oauth/authorize').query({
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'token',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      state: 'client-state-1',
    });

    expect(response.status).toBe(302);
    const target = new URL(response.headers.location);
    expect(target.origin).toBe('https://chatgpt.test');
    expect(target.searchParams.get('error')).toBe('unsupported_response_type');
    expect(target.searchParams.get('state')).toBe('client-state-1');
  });
});

describe('GET /oauth/callback', () => {
  it('tells the client when the user refuses, instead of leaving it waiting', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const state = await startAuthorization(app, clientId);

    const response = await request(app)
      .get('/oauth/callback')
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
    const state = await startAuthorization(app, clientId);

    const response = await request(app)
      .get('/oauth/callback')
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
    const state = await startAuthorization(app, clientId);

    await request(app).get('/oauth/callback').query({ code: 'first', state });
    const replay = await request(app).get('/oauth/callback').query({ code: 'second', state });

    expect(replay.status).toBe(400);
    expect(mockExchange).toHaveBeenCalledTimes(1);
  });

  it('reports a failed exchange to the client rather than a blank page', async () => {
    const app = makeApp();
    const clientId = await registerClient(app);
    const state = await startAuthorization(app, clientId);
    mockExchange.mockRejectedValue(new Error('CodeQR rejected the token request'));

    const response = await request(app).get('/oauth/callback').query({ code: 'c', state });

    const target = new URL(response.headers.location);
    expect(target.origin + target.pathname).toBe('https://chatgpt.test/callback');
    expect(target.searchParams.get('error')).toBe('server_error');
  });
});
