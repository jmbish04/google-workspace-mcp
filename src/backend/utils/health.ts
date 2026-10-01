import type { ModuleResult } from "@/backend/health/types";

/**
 * Secret Store bindings this Worker needs at runtime, by **binding name** — the
 * name the Worker reads off `env`, NOT the name the secret has in the store.
 *
 * Those two differ, and conflating them produced a false alarm that survived
 * until the operator contradicted it: `AI_GATEWAY_TOKEN` is the binding for the
 * secret `CLOUDFLARE_AI_GATEWAY_TOKEN`, and this list previously held the secret
 * name. `env.CLOUDFLARE_AI_GATEWAY_TOKEN` is simply undefined, so the check
 * reported a healthy, correctly-bound secret as missing for days. `GITHUB_TOKEN`
 * is the same shape deliberately — it binds the store's `GH_TOKEN`, because on
 * this account `GITHUB_TOKEN` is a dead credential and `GH_TOKEN` is the live
 * one. Keep this list in step with `wrangler.jsonc`'s `secrets_store_secrets`
 * `binding` values.
 */
const REQUIRED_SECRET_BINDINGS = [
  "GITHUB_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_WRANGLER_API_TOKEN",
  "WORKER_API_KEY",
  "AI_GATEWAY_TOKEN",
  "GOOGLE_CREDS_SA_PRIVATE_KEY_PT_1",
  "GOOGLE_CREDS_SA_PRIVATE_KEY_PT_2",
  "GOOGLE_CREDS_SA_CLIENT_EMAIL",
] as const;

/** Why one required binding failed. */
export interface SecretBindingFault {
  /** The binding name looked up on `env`. */
  binding: string;
  /**
   * `unbound` — no binding of that name exists, so this is a `wrangler.jsonc`
   * configuration bug, not a missing secret. `empty` — the binding resolves but
   * holds nothing. `error` — the store rejected the read.
   *
   * The distinction is the whole point: "missing" sent the last investigation
   * at the Secret Store when the secret was there all along.
   */
  reason: "unbound" | "empty" | "error";
  /** Error text, when `reason` is `error`. */
  detail?: string;
}

/**
 * Verify every required Secret Store binding resolves to a non-empty value.
 *
 * @param env - Worker env
 * @returns `fail` with a per-binding reason when anything is wrong
 * @example
 * const r = await checkSecrets(env);
 * // r.faults?.[0] => { binding: "AI_GATEWAY_TOKEN", reason: "unbound" }
 */
export async function checkSecrets(
  env: Env,
): Promise<ModuleResult & { missing?: string[]; faults?: SecretBindingFault[] }> {
  const start = Date.now();
  const faults: SecretBindingFault[] = [];

  for (const binding of REQUIRED_SECRET_BINDINGS) {
    const slot = (env as unknown as Record<string, unknown>)[binding] as
      | { get?: () => Promise<string | undefined> }
      | undefined;

    // A binding that is not declared cannot be distinguished from an empty one
    // by `?.get()` alone — and reporting it as "missing secret" is what sent the
    // last investigation to the wrong system.
    if (!slot || typeof slot.get !== "function") {
      faults.push({ binding, reason: "unbound" });
      continue;
    }

    try {
      const val = await slot.get();
      if (!val || val.trim() === "") faults.push({ binding, reason: "empty" });
    } catch (e) {
      faults.push({
        binding,
        reason: "error",
        detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      });
    }
  }

  return {
    status: faults.length === 0 ? "ok" : "fail",
    latencyMs: Date.now() - start,
    // `missing` is kept for the existing HealthPanel island, which renders it.
    missing: faults.length > 0 ? faults.map((f) => `${f.binding} (${f.reason})`) : undefined,
    faults: faults.length > 0 ? faults : undefined,
  };
}

/** Verify all required environment variables are present. */
export async function checkEnvVars(env: Env): Promise<ModuleResult & { missing?: string[] }> {
  const start = Date.now();
  const required = [
    "AI_GATEWAY_ID",
    "MODEL_CHAT",
    "MODEL_EXTRACT",
    "MODEL_DRAFT",
  ] as const;

  const missing: string[] = [];
  for (const name of required) {
    const val = (env as Record<string, any>)[name];
    if (!val || (typeof val === "string" && (val.trim() === "" || val.startsWith("<")))) {
      missing.push(name);
    }
  }

  return {
    status: missing.length === 0 ? "ok" : "fail",
    latencyMs: Date.now() - start,
    missing: missing.length > 0 ? missing : undefined,
  };
}
