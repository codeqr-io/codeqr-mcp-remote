/**
 * Client-facing text for a failed tool call.
 *
 * The CodeQR API answers a plan gate with sales copy — "Upgrade to Starter to
 * use this feature" — and the SDK puts the serialized response body into
 * `Error.message`, so passing the error straight through puts a plan name, and
 * sometimes a price, in front of the end user. An app directory that forbids
 * selling a digital service in-app reads that as an upsell; stating the limit
 * and linking to a page outside the app is what it allows.
 *
 * The API text is left alone. It is the right text in the dashboard, where
 * changing the plan is something the customer can actually do from where they
 * are standing, so the translation belongs here and only here.
 */

/**
 * Where the fact can be followed up. Deliberately the help centre and not
 * `/pricing`: the point is to explain the limit, not to route to a checkout.
 *
 * `utm_content` says `limit-reached` rather than naming a plan, because the
 * query string is part of the text the user is shown.
 */
export const HELP_URL =
  'https://codeqr.io/help?utm_source=integration&utm_medium=mcp&utm_campaign=codeqr-mcp&utm_content=limit-reached';

/**
 * Wording that must not reach the client.
 *
 * Matching is sufficient on its own: a message that mentions a plan is
 * rewritten even when its `code` is one this module does not recognise,
 * because the cost of a generic sentence is much lower than the cost of
 * leaking the sales copy of a gate added upstream after this file was written.
 *
 * Every alternative is bounded, because nothing validates tool arguments
 * before the SDK call: a value the model invented reaches the API's zod, and
 * `invalid_enum_value` echoes it back. An unbounded `business` turned
 * `received 'business_card'` into "not available within this workspace's
 * current limits" instead of saying the type does not exist.
 */
const PLAN_WORDING = /\bupgrade\b|\bplans?\b|\bstarter\b|\bpro\b|\bbusiness\b|\$\d/i;

/**
 * The sentence `exceededLimitError` builds in the CodeQR repo: "You have
 * reached the monthly limit of 25 links on the Free plan. Please upgrade…".
 *
 * Matched on the wording, not on `code`, because the code is not the one its
 * name implies. Links, QR codes, clicks and scans — every quota this server
 * can actually reach — are raised as `forbidden` carrying this message
 * (`lib/exceeded.ts`, `lib/api/links/usage-checks.ts`,
 * `lib/api/qrcodes/usage-checks.ts`); only tags, folders, users and projects
 * use `exceeded_limit`. Keying on the code left the common case unrecognised.
 */
const QUOTA = /reached the (?:monthly )?limit of (\d[\d,]*) (\w+)/i;

/** The `type` `exceededLimitError` interpolates, singular and plural. */
const ALLOWANCES: Readonly<Record<string, string>> = {
  link: 'short link',
  links: 'short links',
  qrcode: 'QR code',
  qrcodes: 'QR codes',
  click: 'link click',
  clicks: 'link clicks',
  scan: 'QR code scan',
  scans: 'QR code scans',
  tag: 'tag',
  tags: 'tags',
  domain: 'custom domain',
  domains: 'custom domains',
  folder: 'folder',
  folders: 'folders',
  page: 'page',
  pages: 'pages',
  user: 'workspace member',
  users: 'workspace members',
};

/**
 * Gates the generic pattern below cannot parse, plus the ones it would parse
 * into a worse sentence than a curated one ("This key isn't enabled…").
 */
const CAPABILITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/smart rules?/i, "Smart rules aren't enabled on this workspace."],
  [
    /premium key|keys of \d+ characters?/i,
    "Short and premium keys aren't enabled on this workspace.",
  ],
  [/root domain/i, "Root-domain redirects aren't enabled on this workspace."],
  [/customer profiles?/i, "Customer profiles aren't enabled on this workspace."],
  [/\bfolders?\b/i, "Folders aren't enabled on this workspace."],
];

/**
 * Broad enough to mis-attribute a cause — a domain quota reads as a domain
 * that is out of reach — so it runs after everything that can be read exactly.
 */
const BROAD_CAPABILITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\bdomains?\b/i,
    "This domain isn't available to this workspace. list_domains shows the ones that are.",
  ],
];

/**
 * The shape every free-plan gate in `lib/api/links/process-link.ts` uses: "You
 * can only use custom link preview, password protection and link expiration on
 * a Starter plan." That block gates `proxy`, `password`, `expiresAt`, `ios`,
 * `android`, `geo` and `doIndex` — fields `create_link` and `update_link` put
 * in front of the model — so it is the gate this server trips most, and one
 * pattern covers all of it plus the gates worded the same way elsewhere.
 */
const CAPABILITY_PHRASE = /you can only use (.+?) on (?:a|the) \w+ plan/i;

function fromPhrase(raw: string): string | undefined {
  const phrase = CAPABILITY_PHRASE.exec(raw)?.[1];
  if (!phrase) return undefined;

  // `combineWords` joins that list with commas and a final "and", so a list
  // has to take the plural verb.
  const verb = /,| and /.test(phrase) ? "aren't" : "isn't";
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} ${verb} enabled on this workspace.`;
}

export interface ClientFacingError {
  message: string;
  /** True when the text was rewritten because the API refused on plan grounds. */
  isPlanLimit: boolean;
}

function property(source: unknown, key: string): unknown {
  return typeof source === 'object' && source !== null
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Read structurally rather than with `instanceof APIError`: the SDK ships CJS
 * and ESM builds, so an error can fail the instance check while carrying
 * exactly the fields this needs.
 */
function rawMessage(error: unknown): string {
  const message = property(error, 'message');
  if (typeof message === 'string') return message;
  return typeof error === 'string' ? error : String(error);
}

/**
 * The API's own error code. The SDK exposes the parsed body on `error`, shaped
 * `{ error: { code, message } }`; the regex covers the case where only the
 * serialized message survived, since that string contains the same field.
 */
function errorCode(error: unknown, raw: string): string | undefined {
  const code = property(property(error, 'error'), 'error');
  const value = property(code, 'code');
  if (typeof value === 'string') return value;

  return /"code"\s*:\s*"([a-z_]+)"/.exec(raw)?.[1];
}

function firstMatch(table: ReadonlyArray<readonly [RegExp, string]>, raw: string) {
  return table.find(([pattern]) => pattern.test(raw))?.[1];
}

function withHelp(sentence: string): string {
  return `${sentence} Details: ${HELP_URL}`;
}

/**
 * Rewrite an error from the CodeQR API into something a tool result can carry.
 *
 * Returns the original message unchanged for everything that is not a plan
 * gate, so an ordinary failure still says what actually went wrong.
 */
export function toClientFacingError(error: unknown): ClientFacingError {
  const raw = rawMessage(error);
  const code = errorCode(error, raw);

  const quota = QUOTA.exec(raw);
  if (quota || code === 'exceeded_limit') {
    // The ceiling is kept. D-007 names three things to withhold — a plan name,
    // a price, a sell verb — and a number is none of them; it also does not
    // identify the tier, because a custom limit is granted per workspace and a
    // trial moves the reading. Without it the answer cannot say how far over
    // the request was.
    const allowance = ALLOWANCES[quota?.[2].toLowerCase() ?? ''];
    return {
      message: withHelp(
        allowance
          ? `This workspace has reached its limit of ${quota?.[1]} ${allowance} for the current billing cycle, so the request could not be completed until that limit resets or changes.`
          : 'This workspace has reached one of its limits for the current billing cycle, so the request could not be completed until that limit resets or changes.',
      ),
      isPlanLimit: true,
    };
  }

  // A 429 is about how fast the caller is going, not about what the workspace
  // has — rewriting it would hide the one error that a retry actually fixes.
  if (code === 'rate_limit_exceeded') {
    return { message: raw, isPlanLimit: false };
  }

  if (!PLAN_WORDING.test(raw)) {
    return { message: raw, isPlanLimit: false };
  }

  // The only gate with a way out that costs nothing: ask for less time.
  if (/analytics for up to/i.test(raw)) {
    return {
      message: withHelp(
        'The requested analytics window is longer than this workspace allows; a shorter interval returns the report.',
      ),
      isPlanLimit: true,
    };
  }

  const capability =
    firstMatch(CAPABILITIES, raw) ?? fromPhrase(raw) ?? firstMatch(BROAD_CAPABILITIES, raw);

  // A phrase lifted out of the API's own sentence could carry a tier name with
  // it; the generic sentence is the safe answer when it does.
  const named = capability && !PLAN_WORDING.test(capability) ? capability : undefined;

  return {
    message: withHelp(named ?? "This action isn't available within this workspace's current limits."),
    isPlanLimit: true,
  };
}
