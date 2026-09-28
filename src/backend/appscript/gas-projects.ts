/**
 * @file appscript/gas-projects.ts
 * @description Registry of deployed standalone Apps Script projects the worker
 * RUNS (via `scripts.run`) but does NOT build — their source lives in
 * `core-template-gas`, linked here as the `gas/` git submodule (edit the scripts
 * at `gas/projects/<name>/`; commits there go to core-template-gas, whose CI
 * deploys each project to BOTH accounts, one API-executable scriptId per env).
 * The worker only needs the scriptId + entry function to invoke them.
 *
 * Fill in the per-account scriptIds once core-template-gas CI has created the
 * dedicated projects, OR override at runtime (no redeploy) via the `global_config`
 * key `gas_script:<project>:<accountEmail>` → `{ scriptId }`.
 */
import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { globalConfig } from "@db/schemas";

export interface GasProject {
  /** API-executable entry function invoked via scripts.run. */
  entry: string;
  /** Per-environment scriptId, keyed by lowercased account email. */
  scriptIds: Record<string, string>;
}

/**
 * Known GAS projects deployed from core-template-gas. Seed scriptIds here as the
 * CI creates them; `global_config` overrides win at runtime.
 */
export const GAS_PROJECTS: Record<string, GasProject> = {
  "email-to-pdf": {
    entry: "exportEmailPdf",
    // scripts.run uses the SCRIPT id (the `1…` project id), not the `AKfycb…`
    // deployment id — same as STANDING_SCRIPTS. Deployment ids (for CI redeploys)
    // live in gas/projects/email-to-pdf/project.json accounts[].
    scriptIds: {
      "jmbish04@gmail.com": "1dwFo9llZgMOXzV8ViXKtrW82v9CaHuarwpVyg-pIcFrhKpuiEAYGF648",
      "justin@126colby.com": "1yCzRUF-KYX9mhz39t31dyZIfC1SU7tcWvZywX_wE8kTkjQvWQ5I6ydf-",
    },
  },
};

function configKey(project: string, accountEmail: string): string {
  return `gas_script:${project}:${accountEmail.toLowerCase()}`;
}

/**
 * Resolve the scriptId + entry for a project in a given account. A `global_config`
 * override wins over the seeded {@link GAS_PROJECTS} map; returns undefined when
 * the project is unknown or has no scriptId for that account yet.
 */
export async function resolveGasScript(
  env: Env,
  project: string,
  accountEmail: string,
): Promise<{ scriptId: string; entry: string } | undefined> {
  const proj = GAS_PROJECTS[project];
  if (!proj) return undefined;
  const email = accountEmail.toLowerCase();

  const override = (
    await getDb(env).select().from(globalConfig).where(eq(globalConfig.key, configKey(project, email))).limit(1)
  )[0]?.value as { scriptId?: string } | undefined;

  const scriptId = override?.scriptId ?? proj.scriptIds[email];
  return scriptId ? { scriptId, entry: proj.entry } : undefined;
}

/** Register/override a project's scriptId for an account (no redeploy needed). */
export async function setGasScript(env: Env, project: string, accountEmail: string, scriptId: string): Promise<void> {
  const now = new Date();
  await getDb(env)
    .insert(globalConfig)
    .values({ key: configKey(project, accountEmail), value: { scriptId }, updatedAt: now })
    .onConflictDoUpdate({ target: globalConfig.key, set: { value: { scriptId }, updatedAt: now } });
}
