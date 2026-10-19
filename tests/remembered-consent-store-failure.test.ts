import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  save: vi.fn(),
  get: vi.fn(),
  forget: vi.fn(),
}));

vi.mock('../src/oauth/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/oauth/store.js')>()),
  saveRememberedConsent: store.save,
  getRememberedConsent: store.get,
  forgetRememberedConsent: store.forget,
}));

import { forgetApproval, isRemembered, REMEMBER_COOKIE, rememberApproval } from '../src/oauth/remembered-consent.js';
import { COOKIE_TOKEN_LENGTH } from '../src/oauth/browser-binding.js';

const VERIFIED_REDIRECT = 'https://chatgpt.com/connector/oauth/fcLW7Kbi1AnJ';
const request = { clientId: 'codeqr_client', redirectUri: VERIFIED_REDIRECT, scope: 'mcp:tools' };
const cookieValue = 'a'.repeat(COOKIE_TOKEN_LENGTH);

const reqWithCookie = () => ({ headers: { cookie: `${REMEMBER_COOKIE}=${cookieValue}` } }) as unknown as Request;
const fakeRes = () => ({ cookie: vi.fn(), clearCookie: vi.fn() }) as unknown as Response & {
  cookie: ReturnType<typeof vi.fn>;
  clearCookie: ReturnType<typeof vi.fn>;
};

const silenceStdout = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

describe('a store outage never breaks the connection', () => {
  let stdout: ReturnType<typeof silenceStdout>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = silenceStdout();
  });
  afterEach(() => stdout.mockRestore());

  const loggedReasons = () =>
    stdout.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as { reason?: string };
        } catch {
          return {};
        }
      })
      .map((event) => event.reason)
      .filter(Boolean);

  it('a failed save sets no cookie and reports it', async () => {
    store.save.mockRejectedValue(new Error('redis down'));
    const res = fakeRes();

    await expect(rememberApproval(reqWithCookie(), res, request)).resolves.toBeUndefined();

    expect(res.cookie).not.toHaveBeenCalled();
    expect(loggedReasons()).toContain('remember_save_failed');
  });

  it('a failed forget still clears the cookie and reports it', async () => {
    store.forget.mockRejectedValue(new Error('redis down'));
    const res = fakeRes();

    await expect(forgetApproval(reqWithCookie(), res)).resolves.toBeUndefined();

    expect(res.clearCookie).toHaveBeenCalledWith(REMEMBER_COOKIE, expect.any(Object));
    expect(loggedReasons()).toContain('remember_forget_failed');
  });

  it('a failed read shows the screen instead of failing the request', async () => {
    store.get.mockRejectedValue(new Error('redis down'));

    await expect(isRemembered(reqWithCookie(), request)).resolves.toBe(false);
    expect(loggedReasons()).toContain('remember_read_failed');
  });
});
