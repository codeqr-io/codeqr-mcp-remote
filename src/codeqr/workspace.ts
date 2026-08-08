/**
 * Resolves which CodeQR workspace a credential belongs to.
 *
 * Several CodeQR endpoints take `projectSlug` as a required parameter even
 * though the credential already determines the workspace — `GET /links/info` is
 * the one that matters here. Nothing in an MCP request carries that slug, so
 * without this module `get_link_info` cannot construct a valid call at all.
 *
 * `GET /oauth/userinfo` is the only endpoint that answers "which workspace is
 * this?" for a bearer credential. It reads the same `restrictedToken` row that
 * authenticates every other call, which is why it works for both credential
 * kinds this server sees: OAuth access tokens minted through the broker, and
 * the personal API keys of sessions that predate it.
 */

import { config } from '../config.js';

export interface CodeQRWorkspace {
  id: string;
  slug: string;
  name: string;
  plan: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long a resolved workspace is reused.
 *
 * A token is bound to one workspace for its whole life, so the mapping cannot
 * change underneath us — only the workspace's own name and plan can. Ten
 * minutes keeps a plan upgrade visible within a conversation while sparing the
 * round trip on every tool call that needs the slug.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  workspace: CodeQRWorkspace;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export class WorkspaceLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceLookupError';
  }
}

/**
 * The workspace behind an API credential.
 *
 * Throws rather than returning null: every caller needs the slug to build a
 * request, so a missing workspace is a failed tool call, not a degraded one.
 */
export async function getWorkspace(apiKey: string): Promise<CodeQRWorkspace> {
  const cached = cache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.workspace;
  }

  let response: Response;
  try {
    response = await fetch(`${config.codeqrAppUrl}/api/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkspaceLookupError(`Could not reach CodeQR to resolve the workspace: ${reason}`);
  }

  if (!response.ok) {
    throw new WorkspaceLookupError(
      `CodeQR answered ${response.status} when resolving the workspace for this token`,
    );
  }

  // Read as text first: an HTML error page from a proxy would otherwise throw a
  // parser error that says nothing about what actually went wrong.
  const body = await response.text();
  let parsed: { project?: Partial<CodeQRWorkspace> };
  try {
    parsed = JSON.parse(body) as { project?: Partial<CodeQRWorkspace> };
  } catch {
    throw new WorkspaceLookupError('CodeQR returned a non-JSON response when resolving the workspace');
  }

  const project = parsed.project;
  if (!project?.slug) {
    throw new WorkspaceLookupError('CodeQR returned no workspace for this token');
  }

  const workspace: CodeQRWorkspace = {
    id: project.id ?? '',
    slug: project.slug,
    name: project.name ?? project.slug,
    plan: project.plan ?? 'unknown',
  };

  cache.set(apiKey, { workspace, expiresAt: Date.now() + CACHE_TTL_MS });
  return workspace;
}

/** Test seam. Production code never needs this — the TTL handles expiry. */
export function clearWorkspaceCache(): void {
  cache.clear();
}
