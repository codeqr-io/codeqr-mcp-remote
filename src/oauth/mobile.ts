/**
 * Whether a request comes from a phone or tablet, by User-Agent.
 *
 * iPadOS Safari reports itself as a Mac and cannot be told apart from one by
 * User-Agent, so an iPad in that mode counts as desktop.
 */
const MOBILE_USER_AGENT = /Android|iPhone|iPod|iPad|Opera Mini|Opera Mobi|IEMobile|Windows Phone/i;

export function isMobileUserAgent(userAgent: string | undefined): boolean {
  return !!userAgent && MOBILE_USER_AGENT.test(userAgent);
}
