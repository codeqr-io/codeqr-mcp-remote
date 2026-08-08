/**
 * Reads which CodeQR workspace a credential is bound to.
 *
 * `GET /oauth/userinfo` is the only endpoint that answers "which workspace is
 * this, and what may it do?" for a bearer credential. It looks the credential
 * up in the same `restrictedToken` table that authenticates every other call,
 * so it works for both kinds this server sees: OAuth access tokens minted
 * through the broker, and the personal API keys of sessions that predate it.
 *
 * Nothing is cached. An earlier draft held the result for ten minutes, which
 * bought one saved round trip on a tool nobody calls in a loop and cost three
 * problems: a renamed workspace kept serving a stale slug, expired entries
 * were never evicted, and the map key was the raw credential — so a secret
 * stayed in memory long after the request that carried it was done.
 */

import { config } from '../config.js';

export interface CodeQRWorkspace {
  id: string;
  slug: string;
  name: string;
  plan: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

export class WorkspaceLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceLookupError';
  }
}

/**
 * The workspace behind an API credential.
 *
 * Throws rather than returning null: the caller wants to report the workspace,
 * so a missing one is a failed tool call, not a degraded answer.
 */
export async function getWorkspace(apiKey: string): Promise<CodeQRWorkspace> {
  let response: Response;
  try {
    response = await fetch(`${config.codeqrAppUrl}/api/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkspaceLookupError(`Could not reach CodeQR to read the workspace: ${reason}`);
  }

  if (!response.ok) {
    throw new WorkspaceLookupError(
      `CodeQR answered ${response.status} when reading the workspace for this token`,
    );
  }

  // Read as text first: an HTML error page from a proxy would otherwise throw a
  // parser error that says nothing about what actually went wrong.
  const body = await response.text();
  let parsed: { project?: Partial<CodeQRWorkspace> };
  try {
    parsed = JSON.parse(body) as { project?: Partial<CodeQRWorkspace> };
  } catch {
    throw new WorkspaceLookupError('CodeQR returned a non-JSON response when reading the workspace');
  }

  const project = parsed.project;
  if (!project?.slug) {
    throw new WorkspaceLookupError('CodeQR returned no workspace for this token');
  }

  return {
    id: project.id ?? '',
    slug: project.slug,
    name: project.name ?? project.slug,
    plan: project.plan ?? 'unknown',
  };
}
