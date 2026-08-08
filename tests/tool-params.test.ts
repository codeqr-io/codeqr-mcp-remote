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
 * Scope: this proves property *names* only. It says nothing about whether an
 * enum lists the right values, or whether the right properties are marked
 * required — `tool-schemas.test.ts` covers those at runtime.
 *
 * `@codeqr/ts` is pinned to an exact version in package.json so that upgrading
 * is a commit somebody makes on purpose, and this file is what tells them
 * whether the new version moved anything underneath the tools. A caret range
 * would not help: in 0.x semver it never crosses a minor anyway, which is how
 * the dependency sat five releases behind without anyone noticing.
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

const CREATE_LINK = ['url', 'domain', 'key', 'externalId', 'tagIds', 'comments', 'expiresAt', 'password'] as const;
const LIST_LINKS = ['search', 'domain', 'tagId', 'page'] as const;
// All four are keys of LinkRetrieveInfoParams; only the type's required-ness
// is stricter than the route, which is why the handler casts.
const GET_LINK_INFO = ['linkId', 'externalId', 'domain', 'key'] as const;
const UPDATE_LINK = ['url', 'key', 'archived', 'expiresAt', 'comments'] as const;
const CREATE_QRCODE = ['url', 'type', 'domain', 'key', 'size', 'level', 'fgColor', 'bgColor'] as const;
const LIST_QRCODES = ['page'] as const;
const UPDATE_QRCODE = ['url', 'fgColor', 'bgColor', 'archived'] as const;
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

  it('covers every tool that forwards arguments to the SDK', () => {
    // delete_* take only an id, which is a path parameter. get_workspace
    // takes nothing at all.
    const forwarding = TOOLS.map((t) => t.name).filter(
      (n) => !['delete_link', 'delete_qrcode', 'get_workspace'].includes(n),
    );
    expect(Object.keys(CHECKED).sort()).toEqual(forwarding.sort());
  });
});
