/**
 * @file appscript/standing.ts
 * @description Registry of the pre-deployed "standing" Apps Script projects the
 * worker pushes code to — one per account. These projects are already deployed
 * as API-executables, so the deploy pipeline updates their standing deployment
 * to each new version rather than creating fresh deployments.
 *
 * The scriptId per account is seeded below (from the operator's known projects)
 * and can be overridden via `global_config` key `appscript_standing:<account>`.
 * The resolved deploymentId is cached in `global_config` key
 * `appscript_deployment:<scriptId>` after the first deploy.
 */
import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { globalConfig } from "@db/schemas";

/** Known standing script projects, keyed by lowercased account email. */
export const STANDING_SCRIPTS: Record<string, string> = {
  "jmbish04@gmail.com": "1UaZLGkYxsuKslAxQuVF_fBu0JtmT0teYD36A5BsLRuybEIYEKiDwVE8n",
  "justin@126colby.com": "1V3nX3wtrqkNhEC1Nk98P0SGa6FttU2Utfqhvfs7kGoFyZehTl2m4_c7e",
};

function standingKey(accountKey: string): string {
  return `appscript_standing:${accountKey.toLowerCase()}`;
}

function deploymentKey(scriptId: string): string {
  return `appscript_deployment:${scriptId}`;
}

/**
 * Resolve the standing scriptId for an account: an explicit override in
 * `global_config` wins, else the seeded {@link STANDING_SCRIPTS} map.
 */
export async function resolveStandingScript(env: Env, accountKey: string): Promise<string | undefined> {
  const db = getDb(env);
  const cfg = (await db.select().from(globalConfig).where(eq(globalConfig.key, standingKey(accountKey))).limit(1))[0]
    ?.value as { scriptId?: string } | undefined;
  return cfg?.scriptId ?? STANDING_SCRIPTS[accountKey.toLowerCase()];
}

/** Register/override the standing scriptId (and optionally deploymentId) for an account. */
export async function setStandingScript(
  env: Env,
  accountKey: string,
  scriptId: string,
  deploymentId?: string,
): Promise<void> {
  const db = getDb(env);
  const now = new Date();
  await db
    .insert(globalConfig)
    .values({ key: standingKey(accountKey), value: { scriptId }, updatedAt: now })
    .onConflictDoUpdate({ target: globalConfig.key, set: { value: { scriptId }, updatedAt: now } });
  if (deploymentId) await setStandingDeployment(env, scriptId, deploymentId);
}

/** The cached standing deploymentId for a script, if any. */
export async function getStandingDeployment(env: Env, scriptId: string): Promise<string | undefined> {
  const db = getDb(env);
  const cfg = (await db.select().from(globalConfig).where(eq(globalConfig.key, deploymentKey(scriptId))).limit(1))[0]
    ?.value as { deploymentId?: string } | undefined;
  return cfg?.deploymentId;
}

/** Cache the standing deploymentId for a script. */
export async function setStandingDeployment(env: Env, scriptId: string, deploymentId: string): Promise<void> {
  const db = getDb(env);
  const now = new Date();
  await db
    .insert(globalConfig)
    .values({ key: deploymentKey(scriptId), value: { deploymentId }, updatedAt: now })
    .onConflictDoUpdate({ target: globalConfig.key, set: { value: { deploymentId }, updatedAt: now } });
}
