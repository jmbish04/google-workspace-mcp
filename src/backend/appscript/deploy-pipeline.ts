/**
 * @file appscript/deploy-pipeline.ts
 * @description Orchestrates the "agent pushes code" pipeline against a standing
 * Apps Script project:
 *
 *   1. GET current content (preserving the manifest + existing files)
 *   2. merge in the agent's new/modified files (by name)
 *   3. PUT the merged content back to HEAD
 *   4. snapshot an immutable version
 *   5. re-point the standing deployment at that version (or create one)
 *   6. record the deployment in D1 (`appsscript_deployments`) for audit/rollback
 *
 * Executing the freshly-deployed code is a separate step (`appscript_run`),
 * since the deployment is API-executable.
 */
import { desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { appsscriptDeployments } from "@db/schemas";
import { AppsScriptService } from "@/backend/mcp/services/appsscript";

import { mergeAppsScriptFiles, hasManifest, type AppsScriptFile } from "./merge-files";
import { getStandingDeployment, setStandingDeployment } from "./standing";

export interface DeployInput {
  scriptId: string;
  newFiles: AppsScriptFile[];
  useCase: string;
  description?: string;
  /** Explicit deployment to update; else the cached/discovered standing one. */
  deploymentId?: string;
  /** Force a brand-new deployment instead of updating the standing one. */
  createNew?: boolean;
  /** Acting account label recorded in the audit log. */
  account?: string;
}

export interface DeployResult {
  scriptId: string;
  versionNumber: number;
  deploymentId: string;
  updatedStanding: boolean;
  files: { name: string; type: string }[];
}

/** Pull the versioned (non-HEAD) deployment id from a listDeployments response. */
function firstVersionedDeployment(listed: unknown): string | undefined {
  const deployments = (listed as { deployments?: { deploymentId?: string; deploymentConfig?: { versionNumber?: number } }[] })
    ?.deployments;
  return deployments?.find((d) => typeof d.deploymentConfig?.versionNumber === "number" && d.deploymentId)?.deploymentId;
}

/** Read the current file list from a project's content response. */
function currentFiles(content: unknown): AppsScriptFile[] {
  return ((content as { files?: AppsScriptFile[] })?.files ?? []) as AppsScriptFile[];
}

/**
 * Run the full merge → version → deploy pipeline and log the result to D1.
 *
 * @param ref - the account ref for the AppsScriptService (`dwd:<email>`, sub, …)
 * @param account - human account label for the audit row
 */
export async function deployMergedVersion(
  env: Env,
  ref: string,
  input: DeployInput,
): Promise<DeployResult> {
  const svc = new AppsScriptService(env, ref);

  // 1–3. Read, merge, write back HEAD.
  const merged = mergeAppsScriptFiles(currentFiles(await svc.getContent(input.scriptId)), input.newFiles);
  if (!hasManifest(merged)) {
    throw new Error("Refusing to write: merged file set has no `appsscript` manifest (would corrupt the project).");
  }
  await svc.updateContent(input.scriptId, merged);

  // 4. Snapshot an immutable version.
  const { versionNumber } = await svc.createVersion(input.scriptId, `${input.useCase}: ${input.description ?? "update"}`);

  // 5. Re-point the standing deployment, or create a new one.
  let deploymentId = input.deploymentId;
  if (!deploymentId && !input.createNew) {
    deploymentId =
      (await getStandingDeployment(env, input.scriptId)) ?? firstVersionedDeployment(await svc.listDeployments(input.scriptId));
  }

  let updatedStanding: boolean;
  if (deploymentId && !input.createNew) {
    await svc.updateDeployment(input.scriptId, deploymentId, versionNumber, input.description);
    updatedStanding = true;
  } else {
    const dep = await svc.createDeployment(input.scriptId, versionNumber, input.description);
    deploymentId = dep.deploymentId;
    updatedStanding = false;
  }
  // Cache whichever deployment is now the standing one.
  await setStandingDeployment(env, input.scriptId, deploymentId);

  // 6. Audit log.
  await logDeployment(env, {
    scriptId: input.scriptId,
    account: input.account,
    versionNumber,
    deploymentId,
    useCase: input.useCase,
    description: input.description,
    files: input.newFiles.map((f) => ({ name: f.name, type: f.type })),
    action: "deploy",
  });

  return {
    scriptId: input.scriptId,
    versionNumber,
    deploymentId,
    updatedStanding,
    files: input.newFiles.map((f) => ({ name: f.name, type: f.type })),
  };
}

export interface RollbackResult {
  scriptId: string;
  deploymentId: string;
  versionNumber: number;
}

/**
 * Roll a standing deployment back to an earlier version by re-pointing it — no
 * code changes, no recompile. Logs a `rollback` audit row.
 */
export async function rollbackDeployment(
  env: Env,
  ref: string,
  input: { scriptId: string; versionNumber: number; deploymentId?: string; description?: string; account?: string },
): Promise<RollbackResult> {
  const svc = new AppsScriptService(env, ref);
  const deploymentId =
    input.deploymentId ??
    (await getStandingDeployment(env, input.scriptId)) ??
    firstVersionedDeployment(await svc.listDeployments(input.scriptId));
  if (!deploymentId) {
    throw new Error(`No standing deployment found for ${input.scriptId}. Pass deploymentId or register one first.`);
  }

  await svc.updateDeployment(input.scriptId, deploymentId, input.versionNumber, input.description ?? "Rollback");
  await setStandingDeployment(env, input.scriptId, deploymentId);
  await logDeployment(env, {
    scriptId: input.scriptId,
    account: input.account,
    versionNumber: input.versionNumber,
    deploymentId,
    useCase: "rollback",
    description: input.description,
    files: [],
    action: "rollback",
  });

  return { scriptId: input.scriptId, deploymentId, versionNumber: input.versionNumber };
}

/** Deployment history for a script (newest first), from the D1 audit log. */
export async function deploymentHistory(env: Env, scriptId: string): Promise<(typeof appsscriptDeployments.$inferSelect)[]> {
  const db = getDb(env);
  return db
    .select()
    .from(appsscriptDeployments)
    .where(eq(appsscriptDeployments.scriptId, scriptId))
    .orderBy(desc(appsscriptDeployments.versionNumber));
}

async function logDeployment(
  env: Env,
  row: {
    scriptId: string;
    account?: string;
    versionNumber: number;
    deploymentId: string;
    useCase: string;
    description?: string;
    files: { name: string; type: string }[];
    action: "deploy" | "rollback";
  },
): Promise<void> {
  const db = getDb(env);
  await db.insert(appsscriptDeployments).values({
    scriptId: row.scriptId,
    account: row.account ?? null,
    versionNumber: row.versionNumber,
    deploymentId: row.deploymentId,
    useCase: row.useCase,
    description: row.description ?? null,
    filesManifest: row.files,
    action: row.action,
    createdAt: new Date(),
  });
}
