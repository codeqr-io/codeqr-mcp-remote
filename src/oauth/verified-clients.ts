import { CHATGPT_LOGO_DATA_URI } from './chatgpt-logo.js';

/**
 * Clients CodeQR vouches for on the consent screen.
 *
 * Keyed by exact redirect URI, never by client_name: registration is open, so
 * anyone can call themselves "ChatGPT", but an authorization code is only ever
 * delivered to the registered redirect_uri. Whoever registered a client with
 * one of these URIs, the access lands in the app listed here — which is why the
 * screen shows this entry's name instead of the self-declared one.
 */

export interface VerifiedClient {
  name: string;
  /** A data: URI, so the consent page still loads nothing from another origin. */
  logo?: string;
}

const VERIFIED_CLIENTS: Record<string, VerifiedClient> = {
  // CodeQR's published app in the ChatGPT app directory: the last segment is
  // the callback_id ChatGPT used when connecting it. Whether ChatGPT keeps that
  // ID for every user of the app is not documented anywhere we could check.
  // If it changes, or if this server starts returning RFC 9207 `iss` (which
  // moves every connector to the shared
  // https://chatgpt.com/connector_platform_oauth_redirect), this entry simply
  // stops matching and the app gets the unverified warning, as before.
  'https://chatgpt.com/connector/oauth/fcLW7Kbi1AnJ': { name: 'ChatGPT', logo: CHATGPT_LOGO_DATA_URI },
};

export function findVerifiedClient(redirectUri: string): VerifiedClient | undefined {
  return Object.hasOwn(VERIFIED_CLIENTS, redirectUri) ? VERIFIED_CLIENTS[redirectUri] : undefined;
}
