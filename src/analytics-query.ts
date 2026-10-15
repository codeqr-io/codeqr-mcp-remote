/**
 * Turns get_analytics arguments into the request that answers them. The
 * analytics API takes them literally, and two of its literal readings are
 * not what anyone asking means:
 *
 * - A domain and key without a type is not resolved to a code: the API then
 *   filters by domain alone (app/api/analytics/route.ts), so "this code"
 *   came back as the whole domain. The code is looked up here and named by id.
 * - "scans" without a QR code id runs the composite query, every click event
 *   in `clicks` and `scans` at 0 (the Tinybird count pipe has no scans node).
 *   The `types` filter, which every analytics pipe applies, is what isolates
 *   QR code traffic, and likewise link clicks for "clicks".
 *
 * The card is built from `cardArgs`: the resolved id, plus the domain and key
 * the user named, for its label.
 */

import type Codeqr from '@codeqr/ts';

// The app reads this key as the domain's root redirect, i.e. the domain itself.
const DOMAIN_ROOT_KEY = '_root';

type Args = Record<string, unknown>;

export type ResolvedAnalyticsQuery = { request: Args; cardArgs: Args } | { error: string };

export async function resolveAnalyticsQuery(client: Codeqr, args: Args): Promise<ResolvedAnalyticsQuery> {
  const request: Args = { ...args };
  const cardArgs: Args = { ...args };

  const domain = typeof args.domain === 'string' ? args.domain : undefined;
  const key = typeof args.key === 'string' ? args.key : undefined;
  if (domain && key && key !== DOMAIN_ROOT_KEY && !args.linkId && !args.qrcodeId) {
    const code = await findCode(client, domain, key);
    if (!code) return { error: `No link or QR code at ${domain}/${key} in this workspace.` };
    delete request.domain;
    delete request.key;
    request[code.field] = code.id;
    cardArgs[code.field] = code.id;
  }

  // Top lists are of one kind already; a type filter of the other kind would empty them.
  const isTopList = args.groupBy === 'top_links' || args.groupBy === 'top_qrcodes';
  if (!request.linkId && !request.qrcodeId && !isTopList) {
    if (args.event === 'scans') Object.assign(request, { event: 'clicks', types: 'qrcode' });
    else if (args.event === 'clicks') request.types = 'link';
  }

  return { request, cardArgs };
}

/** QR codes win a tie: their keys are QR code keys, and a scan is what was most likely asked about. */
async function findCode(
  client: Codeqr,
  domain: string,
  key: string,
): Promise<{ field: 'qrcodeId' | 'linkId'; id: string } | undefined> {
  const idOf = (found: unknown) => {
    const id = (found as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id ? id : undefined;
  };
  // Cast because the SDK's parameter types also demand a project slug, which
  // the API takes from the credential instead (as with links.retrieveInfo in
  // routes/mcp.ts).
  const lookup = { domain, key } as never;
  // Only "not found" means the code is not of that kind; any other failure
  // (a rate limit, an outage) must not read as "no such code".
  const unlessNotFound = (error: unknown) => {
    if ((error as { status?: unknown } | null)?.status === 404) return undefined;
    throw error;
  };
  const [qrcode, link] = await Promise.all([
    client.qrcodes.retrieve(lookup).then(idOf, unlessNotFound),
    client.links.retrieveInfo(lookup).then(idOf, unlessNotFound),
  ]);
  if (qrcode) return { field: 'qrcodeId', id: qrcode };
  if (link) return { field: 'linkId', id: link };
  return undefined;
}
