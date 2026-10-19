import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TOOLS } from '../src/routes/mcp.js';
import { isPlaceholderDestination } from '../src/placeholder-destination.js';

const PLUGIN_DIR = resolve(__dirname, '..', 'plugin');
const MAX_NAME = 30;
const MAX_SUBTITLE = 30;
const MAX_DESCRIPTION = 4000;
const MAX_PROMPT = 128;
const MAX_PROMPTS = 3;
const POSITIVE_CASES = 5;
const NEGATIVE_CASES = 3;
const MIN_ICON_PX = 48;
const MIN_CONTRAST = 2;
const TRANSLATION_LOCALES = [
  'de-DE',
  'es-ES',
  'fr-FR',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'pt-BR',
  'pt-PT',
  'ru-RU',
  'zh-CN',
];

function read(rel: string): string {
  return readFileSync(join(PLUGIN_DIR, rel), 'utf8');
}

const manifest = JSON.parse(read('plugin.json'));
const mcp = JSON.parse(read('mcp.json'));
const openai = manifest.extensions['com.openai'];
const iface = openai.interface;

const skillFiles = readdirSync(join(PLUGIN_DIR, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `skills/${d.name}/SKILL.md`);

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

describe('plugin package text limits', () => {
  it('keeps names and descriptions within the submission limits', () => {
    expect(iface.displayName.length).toBeLessThanOrEqual(MAX_NAME);
    expect(iface.shortDescription.length).toBeLessThanOrEqual(MAX_NAME);
    expect(iface.longDescription.length).toBeGreaterThan(0);
    expect(iface.longDescription.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
  });

  it('has at most three unique default prompts without @ mentions', () => {
    const prompts: string[] = iface.defaultPrompt;
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.length).toBeLessThanOrEqual(MAX_PROMPTS);
    expect(new Set(prompts).size).toBe(prompts.length);
    for (const p of prompts) {
      expect(p.length).toBeLessThanOrEqual(MAX_PROMPT);
      expect(p).not.toContain('@');
    }
  });

  it('translates every locale within the limits', () => {
    const translations = openai.publication.translations;
    expect(Object.keys(translations).sort()).toEqual([...TRANSLATION_LOCALES].sort());
    for (const [locale, t] of Object.entries<{ subtitle: string; description: string }>(translations)) {
      expect(t.subtitle.length, `${locale} subtitle`).toBeGreaterThan(0);
      expect(t.subtitle.length, `${locale} subtitle`).toBeLessThanOrEqual(MAX_SUBTITLE);
      expect(t.subtitle, `${locale} subtitle`).not.toContain('\n');
      expect(t.description.length, `${locale} description`).toBeGreaterThan(0);
      expect(t.description.length, `${locale} description`).toBeLessThanOrEqual(MAX_DESCRIPTION);
    }
  });
});

describe('plugin package URLs', () => {
  it('uses only https URLs and no placeholder host', () => {
    const raw = [read('plugin.json'), read('mcp.json'), ...skillFiles.map(read)].join('\n');
    const urls = raw.match(/https?:\/\/[^\s"'<>)\\]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith('https://'), url).toBe(true);
      expect(isPlaceholderDestination(url), url).toBe(false);
    }
  });

  it('declares one OAuth server using dynamic client registration', () => {
    const servers = Object.entries<any>(mcp.mcpServers);
    expect(servers).toHaveLength(1);
    const [name, server] = servers[0];
    expect(name).toBe('codeqr');
    expect(server.type).toBe('streamable-http');
    const auth = server.extensions['com.openai'].auth;
    expect(auth.type).toBe('oauth');
    expect(auth.client).toEqual({ mode: 'dcr' });
  });
});

describe('plugin package review cases', () => {
  const { positive, negative } = openai.review.test_cases;

  it('has exactly five positive and three negative cases', () => {
    expect(positive).toHaveLength(POSITIVE_CASES);
    expect(negative).toHaveLength(NEGATIVE_CASES);
  });

  it('names only tools the server exposes', () => {
    const known = new Set(TOOLS.map((t) => t.name));
    for (const c of positive) {
      const names = String(c.tools_triggered).split(',').map((s) => s.trim());
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(known.has(n), `${c.description}: ${n}`).toBe(true);
      expect(c.expected_behavior.length).toBeGreaterThan(0);
    }
  });

  it('asks for a static Wi-Fi code explicitly and expects a static one', () => {
    const wifi = positive.filter((c: { prompt: string }) => /wi-?fi/i.test(c.prompt));
    expect(wifi.length).toBeGreaterThan(0);
    for (const c of wifi) {
      expect(c.prompt).toMatch(/\bstatic\b/i);
      expect(c.expected_behavior).toMatch(/\bstatic\b/i);
    }
  });

  it('does not promise lead or sale analytics', () => {
    const translations = Object.values<{ description: string }>(openai.publication.translations);
    expect(translations.length).toBeGreaterThan(0);
    expect(iface.longDescription).not.toMatch(/\bsales?\b|\blead,|\bleads and\b/i);
    const translatedTerms = /\bleads\b|лидов|продаж|ventas|ventes|vendite|vendas|Verkauf|売上|판매|销售/i;
    for (const t of translations) expect(t.description).not.toMatch(translatedTerms);
  });

  it('leaves out fields the dashboard owns', () => {
    expect(openai.review.demo_recording_url).toBeUndefined();
    expect(openai.review.commerce).toBe(false);
    expect(openai.publication.countries).toBeUndefined();
  });
});

describe('plugin package files', () => {
  it('resolves the onboarding skill to an included file', () => {
    const rel: string = openai.onboardingSkill;
    expect(rel.startsWith('./')).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, rel))).toBe(true);
    expect(skillFiles).toContain(rel.slice(2));
  });

  it('gives every skill a name and description', () => {
    expect(skillFiles.length).toBeGreaterThan(0);
    for (const f of skillFiles) {
      const front = /^---\n([\s\S]*?)\n---/.exec(read(f));
      expect(front, f).not.toBeNull();
      expect(front![1], f).toMatch(/^name: \S+/m);
      expect(front![1], f).toMatch(/^description: \S+/m);
    }
  });

  it('ships square icons of at least the minimum size', () => {
    for (const rel of [iface.logo, iface.composerIcon] as string[]) {
      const file = join(PLUGIN_DIR, rel);
      expect(existsSync(file), rel).toBe(true);
      const png = readFileSync(file);
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      expect(width).toBe(height);
      expect(width).toBeGreaterThanOrEqual(MIN_ICON_PX);
    }
  });

  it('has a brand color with enough contrast against white', () => {
    expect(iface.brandColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(contrastWithWhite(iface.brandColor)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });
});
