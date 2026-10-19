export const PLACEHOLDER_HOSTS = ['example.com', 'example.org', 'example.net', 'demo.com', 'localhost'];

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string | undefined {
  const parsed = parse(url);
  if (parsed?.protocol === 'http:' || parsed?.protocol === 'https:') return parsed.hostname.toLowerCase();
  // The API stores "example.com/menu" as https://example.com/menu
  // (getUrlFromString), so a destination without a scheme is read the same way.
  return parse(`https://${url}`)?.hostname.toLowerCase() || undefined;
}

export function isPlaceholderDestination(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return PLACEHOLDER_HOSTS.some((placeholder) => host === placeholder || host.endsWith(`.${placeholder}`));
}

// The tools whose `url` is where a code or link sends people. A code printed
// with a placeholder behind it looks finished and leads nowhere, so these are
// refused before anything is written.
const DESTINATION_TOOLS = new Set(['create_link', 'update_link', 'create_qrcode', 'update_qrcode']);

/** The placeholder destination a call would write, if it would write one. */
export function placeholderDestinationIn(
  name: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!DESTINATION_TOOLS.has(name) || typeof args?.url !== 'string') return undefined;
  return isPlaceholderDestination(args.url) ? args.url : undefined;
}

/**
 * Written for the model, which then has to go back to the person: the useful
 * outcome of the refusal is that question, not a retry with another made-up
 * address.
 */
export function placeholderRefusal(url: string): string {
  return `${hostOf(url) ?? url} is a placeholder address, not a real destination, so nothing was created or changed. Ask the person for the real link this should open (for example their menu, website or booking page), then call the tool again with it.`;
}
