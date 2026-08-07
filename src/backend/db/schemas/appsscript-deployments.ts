/**
 * @file src/backend/db/schemas/appsscript-deployments.ts
 * @description Audit log of Apps Script deployments driven by the worker's
 * dynamic code pipeline (see mcp/tools `appscript_deploy_code`). Each row records
 * an immutable version snapshot + the deployment it was pinned to, so an agent
 * can review past variants, map them to use cases, and roll back by re-pointing
 * a standing deployment at an earlier version number.
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const appsscriptDeployments = sqliteTable(
  "appsscript_deployments",
  {
    /** Autoincrement surrogate key. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Apps Script project id the deployment belongs to. */
    scriptId: text("script_id").notNull(),
    /** Acting account (email or sub) that performed the deployment. */
    account: text("account"),
    /** Immutable version number snapshotted for this deployment. */
    versionNumber: integer("version_number").notNull(),
    /** The deployment id pinned to `versionNumber` (standing or freshly created). */
    deploymentId: text("deployment_id").notNull(),
    /** Short use-case label the agent tags the deployment with. */
    useCase: text("use_case").notNull(),
    /** Human-readable description of the change. */
    description: text("description"),
    /** JSON array of the files written this deployment ([{name,type}, …]). */
    filesManifest: text("files_manifest", { mode: "json" }).$type<{ name: string; type: string }[]>().notNull(),
    /** Lifecycle action: "deploy" (new/updated) or "rollback". */
    action: text("action").notNull().default("deploy"),
    /** Unix-epoch timestamp of the deployment. */
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("idx_appsscript_script_version").on(t.scriptId, t.versionNumber)],
);

export const insertAppsscriptDeploymentSchema = createInsertSchema(appsscriptDeployments);
export const selectAppsscriptDeploymentSchema = createSelectSchema(appsscriptDeployments);
export type AppsscriptDeployment = typeof appsscriptDeployments.$inferSelect;
export type NewAppsscriptDeployment = typeof appsscriptDeployments.$inferInsert;
