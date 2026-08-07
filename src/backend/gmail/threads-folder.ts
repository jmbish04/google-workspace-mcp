/**
 * @file gmail/threads-folder.ts
 * @description Resolves the Drive destination for a thread's attachments on the
 * acting email account.
 *
 * Layout:
 *   <root: "MCP Email Threads">/<thread subject>/<attachment files…>
 *
 * The per-account root folder id is created once and cached in `global_config`
 * under `gmail_threads_folder:<accountKey>` so we don't re-create or re-search
 * it on every call. `accountKey` is the acting identity — the impersonated email
 * when `as_user` is set, otherwise the signed-in `sub` — which is unique per
 * Drive account.
 */
import { eq } from "drizzle-orm";

import { getDb } from "@/db";
import { globalConfig } from "@db/schemas";
import { DriveService } from "@/backend/mcp/services/drive";

/** Display name of the per-account root folder that holds all thread subfolders. */
export const THREADS_ROOT_NAME = "MCP Email Threads";

function rootConfigKey(accountKey: string): string {
  return `gmail_threads_folder:${accountKey.toLowerCase()}`;
}

/**
 * Resolve (creating + caching on first use) the id of the per-account
 * "MCP Email Threads" root folder.
 *
 * @param ref - the DriveService account ref (`dwd:<email>`, `sub`, …)
 * @param accountKey - stable per-account cache key (impersonated email or sub)
 */
export async function resolveThreadsRoot(env: Env, ref: string, accountKey: string): Promise<string> {
  const db = getDb(env);
  const key = rootConfigKey(accountKey);
  const cached = (await db.select().from(globalConfig).where(eq(globalConfig.key, key)).limit(1))[0]?.value as
    | { folderId?: string }
    | undefined;
  if (cached?.folderId) return cached.folderId;

  const folderId = await new DriveService(env, ref).findOrCreateFolder(THREADS_ROOT_NAME);
  const now = new Date();
  await db
    .insert(globalConfig)
    .values({ key, value: { folderId }, updatedAt: now })
    .onConflictDoUpdate({ target: globalConfig.key, set: { value: { folderId }, updatedAt: now } });
  return folderId;
}

/** Drive folder names can't contain slashes; keep them readable but safe. */
function safeFolderName(subject: string): string {
  const cleaned = (subject || "(no subject)").replace(/[\\/]+/g, "-").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 200) || "(no subject)";
}

/**
 * Resolve the destination folder id for a thread's attachments.
 *
 * @param subject - the thread subject; becomes the subfolder name
 * @param parentIdOverride - when provided, attachments go straight here and the
 *   threads-root / subject-folder logic is skipped
 */
export async function resolveThreadFolder(
  env: Env,
  ref: string,
  accountKey: string,
  subject: string,
  parentIdOverride?: string,
): Promise<string> {
  if (parentIdOverride) return parentIdOverride;
  const rootId = await resolveThreadsRoot(env, ref, accountKey);
  return new DriveService(env, ref).findOrCreateChildFolder(safeFolderName(subject), rootId);
}
