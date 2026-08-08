import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Set before importing: `config` reads the environment once, at module load.
process.env.CODEQR_APP_URL = 'https://app.example.test';
process.env.CODEQR_OAUTH_CLIENT_ID = 'codeqr_app_test';
process.env.CODEQR_OAUTH_CLIENT_SECRET = 'secret_test';

const { buildAuthorizeUrl, exchangeCodeForCredentials, needsRefresh, refreshCredentials } =
  await import('../src/oauth/codeqr-oauth.js');

const MINUTE = 60 * 1000;

function mockFetchOnce(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildAuthorizeUrl', () => {
  it('asks only for the scopes the tools actually use', () => {
    const url = new URL(buildAuthorizeUrl({ redirectUri: 'https://mcp.test/oauth/callback', state: 's1' }));
    const scopes = (url.searchParams.get('scope') ?? '').split(' ');

    expect(scopes).toContain('qrcodes.write');
    expect(scopes).toContain('analytics.read');
    // Nothing in the MCP surface manages domains or webhooks; requesting write
    // access to them would show the user a consent screen wider than the truth.
    expect(scopes).not.toContain('domains.write');
    expect(scopes).not.toContain('webhooks.write');
  });

  it('points at CodeQR with the parameters its authorize endpoint requires', () => {
    const url = new URL(buildAuthorizeUrl({ redirectUri: 'https://mcp.test/oauth/callback', state: 's1' }));

    expect(url.origin + url.pathname).toBe('https://app.example.test/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('codeqr_app_test');
    expect(url.searchParams.get('redirect_uri')).toBe('https://mcp.test/oauth/callback');
    expect(url.searchParams.get('state')).toBe('s1');
  });
});

describe('needsRefresh', () => {
  it('is false while the token has comfortable life left', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60 * MINUTE })).toBe(false);
  });

  it('is true inside the margin, before the token has actually expired', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 5 * MINUTE })).toBe(true);
  });

  it('is true for a token that already expired', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - MINUTE })).toBe(true);
  });
});

describe('token requests', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the client credentials as a form post, not JSON', async () => {
    const fetchMock = mockFetchOnce(200, {
      access_token: 'codeqr_access_token_x',
      refresh_token: 'r_x',
      expires_in: 604800,
    });

    await exchangeCodeForCredentials({ code: 'c1', redirectUri: 'https://mcp.test/oauth/callback' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://app.example.test/api/oauth/token');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(init.body.toString());
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('c1');
    expect(body.get('client_secret')).toBe('secret_test');
    // CodeQR compares this against the code's stored redirect_uri byte for byte.
    expect(body.get('redirect_uri')).toBe('https://mcp.test/oauth/callback');
  });

  it('derives the expiry from expires_in', async () => {
    mockFetchOnce(200, { access_token: 'a', refresh_token: 'r', expires_in: 604800 });

    const before = Date.now();
    const credentials = await exchangeCodeForCredentials({ code: 'c', redirectUri: 'https://mcp.test/cb' });

    expect(credentials.expiresAt).toBeGreaterThanOrEqual(before + 604800 * 1000);
    expect(credentials.expiresAt).toBeLessThan(before + 604800 * 1000 + 5000);
  });

  it('carries CodeQR’s error code through instead of flattening it', async () => {
    mockFetchOnce(400, {
      error: 'invalid_grant',
      error_description: 'Refresh token reuse detected',
    });

    await expect(refreshCredentials('r_spent')).rejects.toMatchObject({
      code: 'invalid_grant',
      message: 'Refresh token reuse detected',
    });
  });

  it('does not choke when the failure is an HTML page rather than JSON', async () => {
    // A gateway or WAF answering for the app returns HTML; calling .json() on
    // that throws a parse error that hides the real status.
    mockFetchOnce(502, '<html><body>Bad Gateway</body></html>');

    await expect(refreshCredentials('r')).rejects.toThrow(/502/);
  });

  it('rejects a 200 that is missing the tokens', async () => {
    // Treating this as success would store `undefined` as the access token and
    // fail later, far from the cause.
    mockFetchOnce(200, { token_type: 'Bearer', expires_in: 604800 });

    await expect(refreshCredentials('r')).rejects.toThrow(/without access_token/);
  });
});
