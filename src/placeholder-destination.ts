export const PLACEHOLDER_HOSTS = ['example.com', 'example.org', 'example.net', 'demo.com', 'localhost'];

export function isPlaceholderDestination(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return PLACEHOLDER_HOSTS.some((placeholder) => host === placeholder || host.endsWith(`.${placeholder}`));
}
