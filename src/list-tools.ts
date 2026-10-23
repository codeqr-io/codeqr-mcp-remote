/**
 * Page-size bounds and the notes the list tools add to their results.
 */

// The API's own maximums, which the SDK does not carry: a larger pageSize is a
// 400 ("Max page size is N."), not a longer page. Copied from the CodeQR repo:
// `getDomainsQuerySchema` in lib/zod/schemas/domains.ts…
export const DOMAINS_MAX_PAGE_SIZE = 50;
// …and `TAGS_MAX_PAGE_SIZE` in lib/zod/schemas/tags.ts…
export const TAGS_MAX_PAGE_SIZE = 100;
// …and `getPaginationQuerySchema({ pageSize: 100 })` in lib/zod/schemas/links.ts and qrcodes.ts.
export const LINKS_MAX_PAGE_SIZE = 100;
export const QRCODES_MAX_PAGE_SIZE = 100;

// The API's default page is its maximum, and a link or QR code serializes to
// 2-3 KB, so an unsized list_links or list_qrcodes answered with 200-300 KB.
export const DEFAULT_LIST_PAGE_SIZE = 20;

export function withDefaultPageSize(args: Record<string, unknown>, pageSize: number): Record<string, unknown> {
  return args.pageSize == null ? { ...args, pageSize } : args;
}

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

/**
 * A page as long as the page size says nothing about whether it was the last,
 * and without this a model reads the first page as the whole workspace.
 */
export function fullPageNote(args: Record<string, unknown>, result: unknown): string | undefined {
  const { pageSize } = args;
  if (!Array.isArray(result) || typeof pageSize !== 'number' || result.length < pageSize) return undefined;
  const page = Number(args.page) > 1 ? Number(args.page) : 1;
  return `This page is full (${result.length} results, the page size), so there may be more: call again with page ${page + 1} for the next ones.`;
}

/** Whether an empty list_domains result describes the whole workspace. */
export function listsNoCustomDomains(args: Record<string, unknown>, result: unknown): boolean {
  if (!Array.isArray(result) || result.length > 0) return false;
  // An empty later page, or an empty search, says nothing about the workspace.
  const firstPage = args.page == null || Number(args.page) <= 1;
  const unfiltered = args.search == null || String(args.search).trim() === '';
  return firstPage && unfiltered;
}
