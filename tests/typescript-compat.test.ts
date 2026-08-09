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
 * Nothing else catches this. `tsc --noEmit` and `tsc` keep working under 7, so
 * typecheck, tests and build all stay green while deploys fail. That is exactly
 * what happened: a dependabot major landed and the next deploy broke.
 *
 * When @vercel/node supports TypeScript 7, delete this file along with the pin.
 */

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

describe('TypeScript version vs. the Vercel builder', () => {
  it('exposes the compiler API @vercel/node compiles the entrypoint with', () => {
    // The exact property the builder dereferences, and the exact one missing
    // under TypeScript 7.
    expect(ts.sys).toBeDefined();
    expect(typeof ts.sys.readFile).toBe('function');
    expect(typeof ts.sys.fileExists).toBe('function');
  });

  it('is a major @vercel/node can still compile with', () => {
    const major = Number(ts.version.split('.')[0]);
    expect(major).toBeLessThan(7);
  });
});
