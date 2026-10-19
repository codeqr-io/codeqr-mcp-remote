/**
 * Page-size bounds and the empty-result note for list_domains and list_tags.
 */

// The API's own maximums, which the SDK does not carry: a larger pageSize is a
// 400 ("Max page size is N."), not a longer page. Copied from the CodeQR repo:
// `getDomainsQuerySchema` in lib/zod/schemas/domains.ts…
export const DOMAINS_MAX_PAGE_SIZE = 50;
// …and `TAGS_MAX_PAGE_SIZE` in lib/zod/schemas/tags.ts.
export const TAGS_MAX_PAGE_SIZE = 100;

/**
 * A client that loaded the tool list before pageSize had a minimum and a
 * maximum can still send any number; clamping answers that call instead of
 * relaying the API's 400. Only numbers are touched: anything else reaches the
 * API, whose validation message says what is wrong with it.
 */
export function withPageSizeInRange(args: Record<string, unknown>, max: number): Record<string, unknown> {
  const { pageSize } = args;
  if (typeof pageSize !== 'number' || !Number.isFinite(pageSize)) return args;
  return { ...args, pageSize: Math.min(max, Math.max(1, pageSize)) };
}

// Names no domain on purpose: which shared domain a workspace gets depends on its plan.
export const NO_CUSTOM_DOMAINS_NOTE =
  "This workspace has no custom domains. Leaving domain out when creating a link or QR code uses the workspace's default short domain.";

/** Whether an empty list_domains result describes the whole workspace. */
export function listsNoCustomDomains(args: Record<string, unknown>, result: unknown): boolean {
  if (!Array.isArray(result) || result.length > 0) return false;
  // An empty later page, or an empty search, says nothing about the workspace.
  const firstPage = args.page == null || Number(args.page) <= 1;
  const unfiltered = args.search == null || String(args.search).trim() === '';
  return firstPage && unfiltered;
}
