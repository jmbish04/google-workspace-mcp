/**
 * @fileoverview A Durable Object class must be named in FOUR places or the
 * deploy fails — and three of them pass while the fourth is missing.
 *
 * Measured 2026-10-03, deploy run 37096664647 against production:
 *
 *     Cannot apply new-class migration to class 'EmailDraftRoom'
 *     that is not exported by script. [code: 10070]
 *
 * `EmailDraftRoom` was in `wrangler.jsonc` bindings, in its `migrations` tag,
 * in `astro.config.ts` `namedExports`, and in the static `export { … }` at the
 * top of `_worker.ts`. It was NOT in `createExports()`, which is the list the
 * Astro adapter actually reads to build the module's export object. So the
 * export NAME existed and its VALUE was `undefined`.
 *
 * Every instrument said fine: `tsc` passed (the static export is real),
 * `astro build` passed, and the emitted bundle literally contained
 * `EmailDraftRoom2 as EmailDraftRoom`. Only the Cloudflare API, at the end of a
 * deploy, knew. That is the "handler was there, and the thing it handled was
 * not what happened" shape — so this test exists to make the fourth list fail
 * loudly, at `pnpm test`, for every DO anyone adds from here on.
 *
 * It reads the source text rather than importing `_worker.ts`, because the
 * entry pulls in `cloudflare:workers` and the whole Astro SSR tree. The bug is
 * "a name is missing from a list", and the list is readable as text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Strip `//` and `/* *​/` comments so a commented-out entry never counts. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Durable Object class names wrangler expects the script to export. */
function wranglerDoClasses(): { bindings: string[]; migrations: string[] } {
  const src = stripComments(read("wrangler.jsonc"));
  const bindings = [...src.matchAll(/"class_name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  const migrations = [
    ...src.matchAll(/"new_sqlite_classes"\s*:\s*\[([^\]]*)\]/g),
    ...src.matchAll(/"new_classes"\s*:\s*\[([^\]]*)\]/g),
  ].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  return { bindings, migrations };
}

/** The identifiers `createExports()` actually puts on the module. */
function createExportsKeys(): string[] {
  const src = stripComments(read("src/_worker.ts"));
  const body = /export function createExports\(\)\s*\{\s*return\s*\{([\s\S]*?)\n\s*\};/.exec(src);
  if (!body) throw new Error("createExports() not found in src/_worker.ts — update this test with it.");
  return [...body[1].matchAll(/^\s*(?:([A-Za-z0-9_$]+)\s*:\s*[^,]+|([A-Za-z0-9_$]+))\s*,/gm)]
    .map((m) => m[1] ?? m[2])
    .filter(Boolean);
}

/** Names the Astro Cloudflare adapter re-exports from the built worker. */
function astroNamedExports(): string[] {
  const src = stripComments(read("astro.config.ts"));
  const block = /namedExports\s*:\s*\[([\s\S]*?)\]/.exec(src);
  if (!block) throw new Error("namedExports not found in astro.config.ts — update this test with it.");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("Durable Object exports", () => {
  const { bindings, migrations } = wranglerDoClasses();

  it("finds the Durable Objects declared in wrangler.jsonc", () => {
    // Guards the test itself: a parser that silently matched nothing would make
    // every assertion below vacuously true.
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings).toContain("CircuitBreaker");
  });

  it("exports every bound DO class from createExports()", () => {
    // createExports() — NOT the static `export {}` — is what the adapter reads.
    const exported = createExportsKeys();
    expect(exported.length).toBeGreaterThan(0);
    for (const cls of bindings) expect(exported).toContain(cls);
  });

  it("exports every class named in a migration tag", () => {
    // A migration for a class the script does not export is the exact deploy
    // failure this file documents.
    const exported = createExportsKeys();
    for (const cls of migrations) expect(exported).toContain(cls);
  });

  it("lists every bound DO class in the adapter's namedExports", () => {
    const named = astroNamedExports();
    for (const cls of bindings) expect(named).toContain(cls);
  });

  it("re-exports every bound DO class from the worker entry", () => {
    const src = stripComments(read("src/_worker.ts"));
    for (const cls of bindings) {
      expect(src).toMatch(new RegExp(`\\b${cls}\\b`));
    }
  });
});
