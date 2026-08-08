/**
 * Compile-time proof that every argument a tool advertises is one the SDK
 * actually accepts.
 *
 * This is the check that was missing when `track_lead` shipped asking for
 * `customerId`. The runtime tests next door pin what the schemas say; nothing
 * compared them to the SDK, and the `any` at every call site meant the
 * compiler had no opinion either. A field that does not exist upstream is
 * invisible until a real call returns 400.
 *
 * `Accepted` fails to compile when a tool declares a property the SDK's
 * parameter type does not have, so the mistake becomes a build error at the
 * moment the schema is edited — or the moment an SDK upgrade removes a field.
 *
 * Two things are checked here, both at compile time: property *names*, and the
 * enum values a tool advertises.
 *
 * Still not covered, so upgrades need eyes as well: whether an optional
 * parameter became required (`asParams` is a cast, so the compiler cannot
 * see it), and any change in runtime behaviour behind an unchanged signature.
 *
 * `@codeqr/ts` is pinned to an exact version in package.json so that upgrading
 * is a commit somebody makes on purpose. A caret range would not help: in 0.x
 * semver it never crosses a minor anyway, which is how the dependency sat five
 * releases behind without anyone noticing.
 *
 * The runtime assertion at the bottom is deliberate: it keeps the property
 * lists honest, because a list that drifted out of step with the real schema
 * would still typecheck while proving nothing.
 */

import { describe, it, expect } from 'vitest';
import type Codeqr from '@codeqr/ts';
import { TOOLS } from '../src/routes/mcp.js';

/**
 * Resolves to `true` when every member of `Props` is a key of `Params`, and to
 * the offending names otherwise.
 *
 * The conditional distributes over the union, so a single bad name makes the
 * whole result `true | [...]` rather than `true`.
 */
type Accepted<Props extends string, Params> = Props extends Extract<keyof Params, string>
  ? true
  : ['property not accepted by the SDK:', Exclude<Props, Extract<keyof Params, string>>];

/**
 * Forces the check to be an error rather than a value.
 *
 * `type X = Accepted<...>` on its own proves nothing: a type alias holding the
 * failure tuple is perfectly legal TypeScript and compiles silently. Verified
 * by mutation — adding a property the SDK does not have passed the build until
 * the result was constrained here.
 */
type Assert<T extends true> = T;

/** Both directions: the tool offers exactly what the SDK accepts, no more, no less. */
type Same<Tool, Sdk> = [Tool] extends [Sdk]
  ? [Sdk] extends [Tool]
    ? true
    : ['the SDK accepts values this tool does not offer:', Exclude<Sdk, Tool>]
  : ['this tool offers values the SDK rejects:', Exclude<Tool, Sdk>];

/** One direction, for enums the tool narrows on purpose. */
type SubsetOf<Tool, Sdk> = Tool extends Sdk
  ? true
  : ['this tool offers values the SDK rejects:', Exclude<Tool, Sdk>];

const CREATE_LINK = ['url', 'domain', 'key', 'externalId', 'tagIds', 'comments', 'expiresAt', 'password'] as const;
const LIST_LINKS = ['search', 'domain', 'tagId', 'page'] as const;
// All four are keys of LinkRetrieveInfoParams; only the type's required-ness
// is stricter than the route, which is why the handler casts.
const GET_LINK_INFO = ['linkId', 'externalId', 'domain', 'key'] as const;
const UPDATE_LINK = ['url', 'key', 'archived', 'expiresAt', 'comments'] as const;
const QRCODE_PAYLOADS = ['url', 'text', 'phone', 'email', 'sms', 'wifi', 'vcard', 'crypto', 'whatsapp'] as const;
const CREATE_QRCODE = [...QRCODE_PAYLOADS, 'type', 'domain', 'key', 'size', 'level', 'fgColor', 'bgColor'] as const;
const LIST_QRCODES = ['page'] as const;
const UPDATE_QRCODE = [...QRCODE_PAYLOADS, 'fgColor', 'bgColor', 'archived'] as const;
// linkId and qrcodeId are genuine filters here, not path identifiers — the
// analytics endpoint takes them in the query.
const GET_ANALYTICS = ['event', 'groupBy', 'linkId', 'qrcodeId', 'domain', 'key', 'interval'] as const;
const LIST_DOMAINS = ['search', 'page', 'pageSize'] as const;
const LIST_TAGS = ['search', 'page', 'pageSize'] as const;
const CREATE_TAG = ['name', 'color'] as const;

// Each line is a build error the day a schema and the SDK disagree.
type _CreateLink = Assert<Accepted<(typeof CREATE_LINK)[number], Codeqr.LinkCreateParams>>;
type _ListLinks = Assert<Accepted<(typeof LIST_LINKS)[number], Codeqr.LinkListParams>>;
type _GetLinkInfo = Assert<Accepted<(typeof GET_LINK_INFO)[number], Codeqr.LinkRetrieveInfoParams>>;
type _UpdateLink = Assert<Accepted<(typeof UPDATE_LINK)[number], Codeqr.LinkUpdateParams>>;
type _CreateQrcode = Assert<Accepted<(typeof CREATE_QRCODE)[number], Codeqr.QrcodeCreateParams>>;
type _ListQrcodes = Assert<Accepted<(typeof LIST_QRCODES)[number], Codeqr.QrcodeListParams>>;
type _UpdateQrcode = Assert<Accepted<(typeof UPDATE_QRCODE)[number], Codeqr.QrcodeUpdateParams>>;
type _GetAnalytics = Assert<Accepted<(typeof GET_ANALYTICS)[number], Codeqr.AnalyticsRetrieveParams>>;
type _ListDomains = Assert<Accepted<(typeof LIST_DOMAINS)[number], Codeqr.DomainListParams>>;
type _ListTags = Assert<Accepted<(typeof LIST_TAGS)[number], Codeqr.TagListParams>>;
type _CreateTag = Assert<Accepted<(typeof CREATE_TAG)[number], Codeqr.TagCreateParams>>;

// Referencing them keeps `noUnusedLocals` from stripping the assertions.
type _AllChecked = [
  _CreateLink,
  _ListLinks,
  _GetLinkInfo,
  _UpdateLink,
  _CreateQrcode,
  _ListQrcodes,
  _UpdateQrcode,
  _GetAnalytics,
  _ListDomains,
  _ListTags,
  _CreateTag,
];

/**
 * `pathParam` is the property the handler pulls out of the arguments before
 * forwarding the rest as the request body — `update_link` sends `linkId` in
 * the URL, not in the payload, so it is not part of the type being checked.
 *
 * It is named per tool rather than stripped globally because `get_analytics`
 * takes `linkId` and `qrcodeId` as ordinary filters. Removing them everywhere
 * made this test pass while silently covering two fewer properties.
 */
// ── Enum values ──────────────────────────────────────────────────────────────
//
// Mirrored exactly: the tool is meant to offer everything the API takes, so a
// value appearing or disappearing upstream is a change we have to react to.
const TAG_COLOR = ['red', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown'] as const;

type _Color = Assert<Same<(typeof TAG_COLOR)[number], NonNullable<Codeqr.TagCreateParams['color']>>>;

// Narrowed on purpose, so only one direction is checked — but that direction
// matters: it catches the SDK dropping a value we still advertise.
//
//   qrcode type — pix, geo and facetime are broken in the CodeQR app itself:
//                 a dynamic pix code is missing from the middleware's
//                 display-page list and redirects to the site root, the geo
//                 constructor reads the country-targeting map instead of the
//                 coordinates, and facetime has no constructor branch at all
//   analytics event — 'views' belongs to Pages, which this server does not reach
//   analytics groupBy — 'clicks', 'scans' and 'views' are accepted upstream and answer 500
//   analytics interval — 'all_unfiltered' answers 500 for every groupBy offered
//                        here: INTERVAL_DATA has no entry for it, so resolving
//                        the window dereferences undefined. Only the 'clicks'
//                        and 'scans' groupBy branches short-circuit before
//                        that, and neither is offered
const QRCODE_TYPE = ['url', 'text', 'email', 'phone', 'sms', 'wifi', 'vcard', 'crypto', 'whatsapp'] as const;
const ANALYTICS_INTERVAL = ['1h', '24h', '7d', '30d', '90d', 'ytd', '1y', 'all'] as const;
const ANALYTICS_EVENT = ['clicks', 'scans', 'leads', 'sales', 'composite'] as const;
const ANALYTICS_GROUP_BY = [
  'count', 'timeseries', 'countries', 'cities', 'devices', 'browsers', 'os', 'referers',
  'top_links', 'top_qrcodes', 'top_urls',
] as const;

type _QrcodeType = Assert<
  SubsetOf<(typeof QRCODE_TYPE)[number], NonNullable<Codeqr.QrcodeCreateParams['type']>>
>;
type _Interval = Assert<
  SubsetOf<(typeof ANALYTICS_INTERVAL)[number], NonNullable<Codeqr.AnalyticsRetrieveParams['interval']>>
>;
type _Event = Assert<
  SubsetOf<(typeof ANALYTICS_EVENT)[number], NonNullable<Codeqr.AnalyticsRetrieveParams['event']>>
>;
type _GroupBy = Assert<
  SubsetOf<(typeof ANALYTICS_GROUP_BY)[number], NonNullable<Codeqr.AnalyticsRetrieveParams['groupBy']>>
>;

type _AllEnumsChecked = [_Interval, _Color, _QrcodeType, _Event, _GroupBy];

/** Ties each literal above to the enum the tool actually declares. */
const CHECKED_ENUMS: Array<{ tool: string; prop: string; values: readonly string[] }> = [
  { tool: 'get_analytics', prop: 'interval', values: ANALYTICS_INTERVAL },
  { tool: 'get_analytics', prop: 'event', values: ANALYTICS_EVENT },
  { tool: 'get_analytics', prop: 'groupBy', values: ANALYTICS_GROUP_BY },
  { tool: 'create_tag', prop: 'color', values: TAG_COLOR },
  { tool: 'create_qrcode', prop: 'type', values: QRCODE_TYPE },
];

const CHECKED: Record<string, { props: readonly string[]; pathParam?: string }> = {
  create_link: { props: CREATE_LINK },
  list_links: { props: LIST_LINKS },
  get_link_info: { props: GET_LINK_INFO },
  update_link: { props: UPDATE_LINK, pathParam: 'linkId' },
  create_qrcode: { props: CREATE_QRCODE },
  list_qrcodes: { props: LIST_QRCODES },
  update_qrcode: { props: UPDATE_QRCODE, pathParam: 'qrcodeId' },
  get_analytics: { props: GET_ANALYTICS },
  list_domains: { props: LIST_DOMAINS },
  list_tags: { props: LIST_TAGS },
  create_tag: { props: CREATE_TAG },
};

describe('tool arguments are ones the SDK accepts', () => {
  it('checks the same properties the tools actually declare', () => {
    // Without this the type assertions above could quietly go stale: a new
    // property added to a schema and not to its list here would compile, and
    // the guard would pass while covering nothing.
    for (const [name, { props, pathParam }] of Object.entries(CHECKED)) {
      const declared = Object.keys(
        TOOLS.find((t) => t.name === name)?.inputSchema.properties ?? {},
      );
      const body = declared.filter((k) => k !== pathParam);
      expect([...body].sort(), name).toEqual([...props].sort());
    }
  });

  it('checks the same enum values the tools actually declare', () => {
    // Same reason as above: a literal that drifted from the schema would keep
    // the type assertions compiling while covering the wrong thing.
    for (const { tool, prop, values } of CHECKED_ENUMS) {
      const declared = (
        TOOLS.find((t) => t.name === tool)?.inputSchema.properties as
          | Record<string, { enum?: readonly string[] }>
          | undefined
      )?.[prop]?.enum;
      expect(declared, `${tool}.${prop}`).toEqual([...values]);
    }
  });

  it('covers every tool that forwards arguments to the SDK', () => {
    // delete_* take only an id, which is a path parameter. get_workspace
    // takes nothing at all.
    const forwarding = TOOLS.map((t) => t.name).filter(
      (n) => !['delete_link', 'delete_qrcode', 'get_workspace'].includes(n),
    );
    expect(Object.keys(CHECKED).sort()).toEqual(forwarding.sort());
  });
});
