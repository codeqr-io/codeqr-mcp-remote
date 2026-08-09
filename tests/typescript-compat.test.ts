/**
 * Guards the TypeScript major against the Vercel builder.
 *
 * `vercel.json` builds `api/server.ts` with `@vercel/node`, which compiles the
 * entrypoint itself using TypeScript's programmatic API — not the `tsc` binary.
 * It reads the project's own TypeScript, so the version in package.json is the
 * one it gets.
 *
 * TypeScript 7 is the native port and exports exactly two symbols, `version`
 * and `versionMajorMinor`. Everything the builder reaches for is gone, and
 * `@vercel/node` does `options.readFile || ts.sys.readFile`, so the build dies
 * with `Cannot read properties of undefined (reading 'readFile')` — a message
 * that names neither TypeScript nor the version.
 *
 * `tsc --noEmit` and `tsc` keep working under 7, so typecheck, tests and build
 * all stay green while deploys fail. That is exactly what happened: a dependabot
 * major landed and the next deploy broke. `.github/workflows/verify.yml` is what
 * makes this file run on a fresh install before a merge; without it the checks
 * below only ever see whatever happens to sit in someone's node_modules.
 *
 * Both halves are asserted on purpose. The installed copy is what the builder
 * loads, but a range in package.json that permits 7 is what lets the next clean
 * install pick it up — and only one of those is visible to a reviewer reading
 * the diff.
 *
 * When @vercel/node supports TypeScript 7, delete this file along with the pin.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('TypeScript version vs. the Vercel builder', () => {
  it('exposes the compiler API @vercel/node compiles the entrypoint with', () => {
    // The exact property the builder dereferences, and the exact one missing
    // under TypeScript 7.
    expect(ts.sys).toBeDefined();
    expect(typeof ts.sys.readFile).toBe('function');
    expect(typeof ts.sys.fileExists).toBe('function');
  });

  it('has an installed major @vercel/node can still compile with', () => {
    const major = Number(ts.version.split('.')[0]);
    expect(major).toBeLessThan(7);
  });

  it('declares a range that cannot resolve to 7 on a clean install', () => {
    // Editing package.json without reinstalling leaves node_modules on the old
    // copy, so the two checks above still pass while the next clean install —
    // the Vercel build, or CI — pulls 7 and breaks.
    const range = packageJson.devDependencies.typescript;
    expect(range).toMatch(/^[\^~]?[0-6]\./);
  });
});
