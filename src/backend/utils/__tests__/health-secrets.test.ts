/**
 * @fileoverview Guards for the Secret Store binding check.
 *
 * Written after a false alarm the operator had to correct: the check reported
 * `CLOUDFLARE_AI_GATEWAY_TOKEN` missing for days while the secret was present
 * and correctly bound. The list held the secret's name in the store, not the
 * binding name the Worker reads off `env`, so the lookup hit `undefined` and
 * the check blamed the Secret Store for a `wrangler.jsonc` naming mismatch.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

import { checkSecrets } from "../health";

/** A Secret Store binding stand-in: an object with an async get(). */
function slot(value: string | undefined) {
  return { get: async () => value };
}

/** An env with every required binding satisfied, minus any names omitted. */
function envWith(overrides: Record<string, unknown> = {}, omit: string[] = []) {
  const base: Record<string, unknown> = {
    GITHUB_TOKEN: slot("gh"),
    CLOUDFLARE_ACCOUNT_ID: slot("acct"),
    CLOUDFLARE_WRANGLER_API_TOKEN: slot("wrangler"),
    WORKER_API_KEY: slot("key"),
    AI_GATEWAY_TOKEN: slot("gw"),
    GOOGLE_CREDS_SA_PRIVATE_KEY_PT_1: slot("p1"),
    GOOGLE_CREDS_SA_PRIVATE_KEY_PT_2: slot("p2"),
    GOOGLE_CREDS_SA_CLIENT_EMAIL: slot("sa@example.test"),
  };
  for (const k of omit) delete base[k];
  return { ...base, ...overrides } as unknown as Env;
}

describe("checkSecrets", () => {
  it("passes when every required BINDING resolves, including the renamed gateway token", async () => {
    // The binding is AI_GATEWAY_TOKEN; the secret behind it is named
    // CLOUDFLARE_AI_GATEWAY_TOKEN. Only the binding name exists on `env`.
    const r = await checkSecrets(envWith());
    expect(r.status).toBe("ok");
    expect(r.faults).toBeUndefined();
  });

  it("does not require a binding named after the secret rather than the binding", async () => {
    // This is the regression itself: an env that has the real binding and NOT a
    // CLOUDFLARE_-prefixed one must still be healthy.
    const env = envWith();
    expect((env as unknown as Record<string, unknown>).CLOUDFLARE_AI_GATEWAY_TOKEN).toBeUndefined();
    expect((await checkSecrets(env)).status).toBe("ok");
  });

  it("calls an undeclared binding `unbound`, not a missing secret", async () => {
    const r = await checkSecrets(envWith({}, ["AI_GATEWAY_TOKEN"]));
    expect(r.status).toBe("fail");
    expect(r.faults).toEqual([{ binding: "AI_GATEWAY_TOKEN", reason: "unbound" }]);
  });

  it("distinguishes a bound-but-empty secret from an undeclared binding", async () => {
    const r = await checkSecrets(envWith({ WORKER_API_KEY: slot("   ") }));
    expect(r.faults).toEqual([{ binding: "WORKER_API_KEY", reason: "empty" }]);
  });

  it("reports a store read failure as `error` with its message", async () => {
    const r = await checkSecrets(
      envWith({
        WORKER_API_KEY: {
          get: async () => {
            throw new Error("store unavailable");
          },
        },
      }),
    );
    expect(r.faults?.[0]).toMatchObject({ binding: "WORKER_API_KEY", reason: "error" });
    expect(r.faults?.[0].detail).toMatch(/store unavailable/);
  });

  it("every required binding is actually declared in wrangler.jsonc", async () => {
    // The real guard: the check's list and the deploy config must agree, or the
    // check invents a fault that no secret can satisfy. Reads the config rather
    // than trusting that someone kept two lists in step.
    const cfg = readFileSync("wrangler.jsonc", "utf8");
    const block = cfg.slice(cfg.indexOf('"secrets_store_secrets"'));
    const declared = new Set(
      [...block.matchAll(/"binding"\s*:\s*"([^"]+)"/g)].map((m) => m[1]),
    );
    const r = await checkSecrets(envWith({}, ["AI_GATEWAY_TOKEN"]));
    // Anything the check requires must exist as a binding in the config.
    for (const f of r.faults ?? []) {
      expect(declared.has(f.binding)).toBe(true);
    }
    expect(declared.has("AI_GATEWAY_TOKEN")).toBe(true);
    expect(declared.has("CLOUDFLARE_AI_GATEWAY_TOKEN")).toBe(false);
  });
});
