/**
 * @file src/backend/db/schemas/doc-export-jobs.ts
 * @description Audit log for the Google Docs → file export utility (mcp tool
 * `docs_export`). One row per requested doc (an array export writes many rows,
 * grouped by `requestId`), recording the format + tab scope, which registered
 * account owned the doc, where the exported file landed (Drive id / url /
 * download url), the export content hash, and the source doc's modifiedTime at
 * export (which revision was captured).
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const docExportJobs = sqliteTable(
  "doc_export_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** UUID grouping every row produced by a single export call. */
    requestId: text("request_id").notNull(),
    /** The original ref the caller passed (Drive id OR url). */
    requestedRef: text("requested_ref").notNull(),
    /** Bare document id extracted from `requestedRef`. */
    documentId: text("document_id").notNull(),
    /** Email of the account the doc was read from. */
    sourceAccount: text("source_account"),
    /** JSON array of account emails tried before one succeeded (or all, on failure). */
    triedAccounts: text("tried_accounts", { mode: "json" }).$type<string[]>(),
    /** "done" | "error". */
    status: text("status").notNull(),
    /** Export format (pdf, markdown, docx, …). */
    format: text("format").notNull(),
    /** Tab scope: "all" | "first" | a tabId. */
    tabScope: text("tab_scope").notNull(),
    /** Drive id / view url / download url of the exported file. */
    exportDriveId: text("export_drive_id"),
    exportDriveUrl: text("export_drive_url"),
    exportDownloadUrl: text("export_download_url"),
    /** SHA-256 (hex) of the exported bytes. */
    exportSha256: text("export_sha256"),
    /** Source doc modifiedTime at export — which revision was captured. */
    sourceModifiedTime: text("source_modified_time"),
    /** Error message when `status = "error"`. */
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("idx_doc_export_document").on(t.documentId),
    index("idx_doc_export_request").on(t.requestId),
  ],
);

export const insertDocExportJobSchema = createInsertSchema(docExportJobs);
export const selectDocExportJobSchema = createSelectSchema(docExportJobs);
export type DocExportJob = typeof docExportJobs.$inferSelect;
export type NewDocExportJob = typeof docExportJobs.$inferInsert;
