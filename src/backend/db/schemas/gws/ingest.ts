/**
 * @fileoverview Routing rules, their audit trail, poll cursors and the work queue.
 *
 * `ingest_rules` are the "advanced filters" deciding what gets indexed (Gmail and Drive).
 * `ingest_jobs` is a Postgres queue claimed with `FOR UPDATE SKIP LOCKED`; no Cloudflare
 * Queue is involved.
 */
import { index, integer, jsonb, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { gws } from "./_base";
import { accounts } from "./accounts";
import { driveFiles, gmailAttachments } from "./files";
import { gmailMessages } from "./messages";
import { projects } from "../pg-app/projects";

export const ruleTarget = gws.enum("rule_target", ["gmail", "drive"]);
export const jobKind = gws.enum("job_kind", [
  "index_message",
  "stage_attachment",
  "extract_attachment",
  "embed_message",
  "embed_content",
  "index_drive_file",
]);
export const jobStatus = gws.enum("job_status", ["queued", "running", "done", "error"]);

export interface RuleConditions {
  from?: string[];
  to?: string[];
  subjectContains?: string[];
  bodyContains?: string[];
  labels?: string[];
  gmailQuery?: string;
  driveFolderIds?: string[];
  mimeTypes?: string[];
}
export interface RuleActions {
  index?: boolean;
  embed?: boolean;
  extractAttachments?: boolean;
  addLabels?: string[];
  projectKey?: string;
}

export const ingestRules = gws.table(
  "ingest_rules",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
    target: ruleTarget("target").notNull(),
    priority: integer("priority").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),
    conditions: jsonb("conditions").$type<RuleConditions>().notNull().default({}),
    actions: jsonb("actions").$type<RuleActions>().notNull().default({}),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ingest_rules_target_priority_idx").on(t.target, t.enabled, t.priority)],
);

export const ingestRuleHits = gws.table(
  "ingest_rule_hits",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    ruleId: integer("rule_id").notNull().references(() => ingestRules.id, { onDelete: "cascade" }),
    messageId: integer("message_id").references(() => gmailMessages.id, { onDelete: "cascade" }),
    driveFileId: integer("drive_file_id").references(() => driveFiles.id, { onDelete: "cascade" }),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ingest_rule_hits_rule_idx").on(t.ruleId, t.matchedAt)],
);

export const syncCursors = gws.table("sync_cursors", {
  accountId: integer("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  historyId: text("history_id"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  status: text("status").notNull().default("idle"),
  error: text("error"),
});

export const ingestJobs = gws.table(
  "ingest_jobs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    kind: jobKind("kind").notNull(),
    messageId: integer("message_id").references(() => gmailMessages.id, { onDelete: "cascade" }),
    attachmentId: integer("attachment_id").references(() => gmailAttachments.id, { onDelete: "cascade" }),
    status: jobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ingest_jobs_claim_idx").on(t.status, t.runAfter)],
);
