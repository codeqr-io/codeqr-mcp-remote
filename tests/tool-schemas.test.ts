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
  it('is exactly the set the directory submission declares', () => {
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

  it('describes every property', () => {
    // The description is what the model reads to decide what to pass. An
    // undescribed property is one it will guess at.
    for (const t of TOOLS) {
      for (const [key, schema] of Object.entries(t.inputSchema.properties ?? {})) {
        expect((schema as { description?: string }).description, `${t.name}.${key}`).toBeTruthy();
      }
    }
  });
});

describe('required arguments match what the API demands', () => {
  it('get_link_info asks for the domain and key pair, and nothing else', () => {
    // GET /links/info requires projectSlug, domain and key together. linkId is
    // not a substitute for the pair, and the earlier schema offering all four
    // as optionals meant the natural call could only ever fail.
    expect(required('get_link_info').sort()).toEqual(['domain', 'key']);
  });

  it('get_link_info does not ask the caller for projectSlug', () => {
    // It is required by the API but unknowable to an MCP client, so it is
    // resolved from the credential instead. Asking for it would push a value
    // the model can only invent into a required field.
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
      'all_unfiltered',
    ]);
  });

  it('offers only the QR type it can actually build a payload for', () => {
    // Every other type — wifi, vcard, whatsapp, pix — carries its content in a
    // payload field of its own, and none of those are exposed yet. Listing the
    // types without the payloads advertised nine capabilities that returned
    // 400. Widen this only alongside the matching properties.
    expect(properties('create_qrcode').type?.enum).toEqual(['url']);
  });

  it('constrains the analytics event and groupBy', () => {
    expect(properties('get_analytics').event?.enum).toContain('scans');
    expect(properties('get_analytics').event?.enum).toContain('clicks');
    // 'clicks', 'scans' and 'views' are valid groupBy values upstream but
    // currently answer 500, so offering them would only route the agent into
    // a failure.
    expect(properties('get_analytics').groupBy?.enum).not.toContain('views');
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
