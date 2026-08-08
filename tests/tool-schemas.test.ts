/**
 * Guards on the tool declarations themselves.
 *
 * These exist because of a specific failure: `track_lead` and `track_sale`
 * shipped sending `customerId`, a field the CodeQR API has never had, and the
 * mistake survived typecheck, build and review. Nothing compared the schemas
 * against the SDK, because every handler passed its arguments through `any`.
 *
 * The compiler still cannot make that comparison. What it can do is fail when
 * a schema is internally inconsistent, and what these tests do is pin the
 * facts a reviewer would otherwise have to re-derive by hand: which tools
 * exist, which arguments are mandatory, and which values the API accepts.
 *
 * When the SDK changes, this file is the thing to update — deliberately.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOOLS } from '../src/routes/mcp.js';

type Tool = (typeof TOOLS)[number];

function tool(name: string): Tool {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`No such tool: ${name}`);
  return found;
}

function properties(name: string): Record<string, { enum?: readonly string[] }> {
  return (tool(name).inputSchema.properties ?? {}) as Record<string, { enum?: readonly string[] }>;
}

function required(name: string): string[] {
  return [...(((tool(name).inputSchema as { required?: string[] }).required as string[]) ?? [])];
}

describe('tool inventory', () => {
  it('matches the tools the submission artifact declares', () => {
    // Reads chatgpt-app-submission.json rather than restating its contents.
    // An earlier version of this test claimed to check the submission and
    // compared against a literal in the test file instead, so the artifact
    // could drift — and did, still declaring two tools the server had already
    // dropped. Announcing a tool that always fails is a documented rejection
    // cause, so the artifact has to be checked against the server, not trusted.
    const submission = JSON.parse(
      readFileSync(new URL('../chatgpt-app-submission.json', import.meta.url), 'utf8'),
    ) as { tools: Record<string, unknown> };

    expect(Object.keys(submission.tools).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it('carries a justification for all three annotations of every submitted tool', () => {
    // The directory requires a justification per annotation value. A tool
    // added to the server and copied into the artifact without them fails
    // submission validation rather than review.
    const submission = JSON.parse(
      readFileSync(new URL('../chatgpt-app-submission.json', import.meta.url), 'utf8'),
    ) as {
      tools: Record<
        string,
        { annotations: Record<string, boolean>; justifications: Record<string, string> }
      >;
    };

    for (const [name, entry] of Object.entries(submission.tools)) {
      expect(Object.keys(entry.justifications).sort(), name).toEqual([
        'destructive_justification',
        'open_world_justification',
        'read_only_justification',
      ]);
      // The artifact's annotations must be the server's, not a second opinion.
      const server = TOOLS.find((t) => t.name === name);
      expect(entry.annotations, name).toEqual(server?.annotations);
    }
  });

  it('is the list this server actually serves', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'create_link',
      'list_links',
      'get_link_info',
      'update_link',
      'delete_link',
      'create_qrcode',
      'list_qrcodes',
      'update_qrcode',
      'delete_qrcode',
      'get_analytics',
      'list_domains',
      'list_tags',
      'create_tag',
      'get_workspace',
    ]);
  });

  it('does not offer conversion tracking', () => {
    // Restoring these needs the `conversions.write` scope, which cannot be
    // requested without locking non-owners out of the connection entirely.
    // Re-adding the tool alone would ship two calls that always fail.
    const names = TOOLS.map((t) => t.name);
    expect(names).not.toContain('track_lead');
    expect(names).not.toContain('track_sale');
  });

  it('names every tool in the snake_case the directory expects', () => {
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('annotations', () => {
  it('sets all three hints explicitly on every tool', () => {
    // The directory requires each of the three, plus a justification per value.
    // A tool inheriting a default would be submitted with a hint nobody chose.
    for (const t of TOOLS) {
      expect(Object.keys(t.annotations).sort(), t.name).toEqual([
        'destructiveHint',
        'openWorldHint',
        'readOnlyHint',
      ]);
    }
  });

  it('never marks a read-only tool as destructive or open-world', () => {
    for (const t of TOOLS) {
      if (t.annotations.readOnlyHint) {
        expect(t.annotations.destructiveHint, t.name).toBe(false);
        expect(t.annotations.openWorldHint, t.name).toBe(false);
      }
    }
  });

  it('marks every tool that overwrites or removes a public destination as destructive', () => {
    for (const name of ['update_link', 'delete_link', 'update_qrcode', 'delete_qrcode']) {
      expect(tool(name).annotations.destructiveHint, name).toBe(true);
      expect(tool(name).annotations.openWorldHint, name).toBe(true);
    }
  });

  it('marks creation as open-world but not destructive', () => {
    for (const name of ['create_link', 'create_qrcode']) {
      expect(tool(name).annotations.openWorldHint, name).toBe(true);
      expect(tool(name).annotations.destructiveHint, name).toBe(false);
    }
  });
});

describe('schema structure', () => {
  it('only marks properties that exist as required', () => {
    // A required entry with no matching property can never be satisfied: the
    // client rejects the call before it reaches us, so the tool is dead on
    // arrival. This is the cheapest possible check for a typo in either list.
    for (const t of TOOLS) {
      const declared = Object.keys(t.inputSchema.properties ?? {});
      for (const key of required(t.name)) {
        expect(declared, `${t.name}.${key}`).toContain(key);
      }
    }
  });

  it('describes every property, including the nested ones', () => {
    // The description is what the model reads to decide what to pass. An
    // undescribed property is one it will guess at — and the QR payloads are
    // where guessing is most expensive, because a wrong key saves happily and
    // encodes nothing. So this recurses rather than stopping at the top level.
    const walk = (schema: unknown, path: string): void => {
      const node = schema as {
        description?: string;
        properties?: Record<string, unknown>;
      };
      expect(node.description, path).toBeTruthy();
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        walk(child, `${path}.${key}`);
      }
    };

    for (const t of TOOLS) {
      for (const [key, schema] of Object.entries(t.inputSchema.properties ?? {})) {
        walk(schema, `${t.name}.${key}`);
      }
    }
  });
});

describe('required arguments match what the API demands', () => {
  it('get_link_info accepts any of the identifiers the route accepts', () => {
    // GET /links/info rejects the call only when domain, key, linkId and
    // externalId are all missing (app/api/links/info/route.ts). Requiring the
    // domain+key pair would drop linkId — the identifier list_links returns,
    // and therefore the one an agent actually holds.
    expect(Object.keys(properties('get_link_info')).sort()).toEqual([
      'domain',
      'externalId',
      'key',
      'linkId',
    ]);
    expect(required('get_link_info')).toEqual([]);
  });

  it('get_link_info does not ask the caller for projectSlug', () => {
    // The SDK's type demands it, but the route ignores it: for a restricted
    // credential the workspace always comes from the token itself
    // (lib/auth/index.ts). Asking would push a value the model can only
    // invent into the request.
    expect(Object.keys(properties('get_link_info'))).not.toContain('projectSlug');
  });

  it('get_analytics requires both event and groupBy', () => {
    expect(required('get_analytics').sort()).toEqual(['event', 'groupBy']);
  });

  it('requires an identifier on every tool that acts on one existing record', () => {
    expect(required('update_link')).toEqual(['linkId']);
    expect(required('delete_link')).toEqual(['linkId']);
    expect(required('update_qrcode')).toEqual(['qrcodeId']);
    expect(required('delete_qrcode')).toEqual(['qrcodeId']);
  });

  it('requires nothing to read the workspace', () => {
    expect(required('get_workspace')).toEqual([]);
  });
});

describe('enums match the values the API accepts', () => {
  it('constrains tag colour to the seven the API allows', () => {
    expect(properties('create_tag').color?.enum).toEqual([
      'red',
      'yellow',
      'green',
      'blue',
      'purple',
      'pink',
      'brown',
    ]);
  });

  it('constrains the analytics interval instead of taking free text', () => {
    expect(properties('get_analytics').interval?.enum).toEqual([
      '1h',
      '24h',
      '7d',
      '30d',
      '90d',
      'ytd',
      '1y',
      'all',
    ]);
  });

  it('offers every QR type it can actually build a payload for', () => {
    expect(properties('create_qrcode').type?.enum).toEqual([
      'url',
      'text',
      'email',
      'phone',
      'sms',
      'wifi',
      'vcard',
      'crypto',
      'whatsapp',
    ]);
  });

  it('offers no QR type that is broken in the CodeQR app', () => {
    // pix   — a dynamic code is absent from the middleware's display-page list
    //         and redirects to the site root instead of paying
    // geo   — the constructor reads `geo.latLog`, the country-targeting map,
    //         while the coordinates live in `latlog`; encodes geo:undefined
    // facetime — no constructor branch at all; encodes an empty string
    //
    // All three need a fix in the app. Offering them here would repeat exactly
    // the mistake this tool was corrected for: advertising silence.
    const offered = properties('create_qrcode').type?.enum ?? [];
    for (const broken of ['pix', 'geo', 'facetime', 'latlog']) {
      expect(offered, broken).not.toContain(broken);
    }
  });

  it('accepts each type’s payload on both create and update', () => {
    // A wifi or vcard code that can be created and never edited defeats the
    // point of it being dynamic.
    for (const payload of ['url', 'text', 'phone', 'email', 'sms', 'wifi', 'vcard', 'crypto', 'whatsapp']) {
      expect(Object.keys(properties('create_qrcode')), payload).toContain(payload);
      expect(Object.keys(properties('update_qrcode')), payload).toContain(payload);
    }
  });

  it('names the payload fields the display page actually reads', () => {
    // The display page is the right reference, not qrCodeConstructor: this
    // tool only creates dynamic codes, and every dynamic scan is rewritten to
    // that page. The two diverge for crypto, and auditing against the
    // constructor is how `crypto.email` — the static path's field — shipped in
    // the first draft, producing "No crypto payment information available".
    const props = properties('create_qrcode') as Record<
      string,
      { properties?: Record<string, unknown>; required?: string[] }
    >;
    expect(Object.keys(props.crypto?.properties ?? {})).toContain('address');
    expect(Object.keys(props.crypto?.properties ?? {})).not.toContain('email');
    // Named nothing like what they hold, and identical on both paths.
    expect(Object.keys(props.email?.properties ?? {})).toContain('cco');
    expect(Object.keys(props.sms?.properties ?? {})).toContain('subject');
    // The two the API itself rejects when missing.
    expect(props.wifi?.required).toEqual(['ssid']);
    expect(props.whatsapp?.required).toEqual(['number']);
  });

  it('offers no field the API cannot store', () => {
    // Wi-Fi payloads are validated as a map of strings, so a boolean never
    // arrives — and the string that would pass encodes the opposite, since the
    // encoder tests it for truthiness and "false" is truthy.
    const props = properties('create_qrcode') as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    expect(Object.keys(props.wifi?.properties ?? {})).not.toContain('isHidden');
  });

  it('requires nothing across all nine QR types', () => {
    // `url` was required back when this tool made link codes only. Left in
    // place, a wifi or vcard call is either rejected by a validating client or
    // padded with a URL the model invented.
    expect(required('create_qrcode')).toEqual([]);
  });

  it('constrains the analytics event and groupBy', () => {
    expect(properties('get_analytics').event?.enum).toContain('scans');
    expect(properties('get_analytics').event?.enum).toContain('clicks');
    // 'clicks', 'scans' and 'views' are valid groupBy values upstream but
    // currently answer 500, so offering them would only route the agent into
    // a failure.
    expect(properties('get_analytics').groupBy?.enum).not.toContain('views');
  });

  it('does not offer the one interval that cannot answer', () => {
    // 'all_unfiltered' passes the API's own Zod enum, so it looks valid from
    // the outside and the SDK type accepts it. It then answers 500 for every
    // groupBy offered here: the interval-to-window map has no entry for it, so
    // resolving the start date reads a property off undefined. The only two
    // branches that return before that point are keyed on groupBy 'clicks' and
    // 'scans', which are themselves withheld for answering 500.
    //
    // Mirroring the SDK exactly is the rule for enums, and this is the
    // documented exception. 'all' covers the same intent and works.
    expect(properties('get_analytics').interval?.enum).not.toContain('all_unfiltered');
    expect(properties('get_analytics').interval?.enum).toContain('all');
  });
});

describe('list tools can page', () => {
  it('accepts pagination wherever a workspace can outgrow one page', () => {
    // list_domains and list_tags were previously called with no arguments at
    // all, so a workspace with more items than the default page reported a
    // truncated list as though it were complete.
    for (const name of ['list_domains', 'list_tags']) {
      expect(Object.keys(properties(name)), name).toContain('page');
      expect(Object.keys(properties(name)), name).toContain('pageSize');
    }
  });
});
