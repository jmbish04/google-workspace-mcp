/**
 * @file src/backend/db/schemas/pdf-generation-logs.ts
 * @description Audit and management log for all generated PDF documents.
 * Stores R2 object keys, Google Drive file/folder metadata, permissions,
 * and secure locked-down Worker view tokens.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const pdfGenerationLogs = sqliteTable("pdf_generation_logs", {
  id: text("id").primaryKey(),
  templateId: text("template_id"),
  title: text("title").notNull(),
  /** Input variables passed to pdfme generator (JSON string) */
  inputDataJson: text("input_data_json").notNull(),
  /** Schema snapshot at time of generation (JSON string) */
  schemaSnapshotJson: text("schema_snapshot_json"),
  byteSize: integer("byte_size").default(0),
  pageCount: integer("page_count").default(1),
  
  // Cloudflare R2 storage
  r2Key: text("r2_key"),
  r2ShareUrl: text("r2_share_url"),
  
  // Google Drive storage & sharing
  driveFileId: text("drive_file_id"),
  driveUrl: text("drive_url"),
  driveFolderId: text("drive_folder_id"),
  driveFolderName: text("drive_folder_name"),
  driveAccountEmail: text("drive_account_email"),
  driveSharingRole: text("drive_sharing_role"), // e.g. "anyone-viewer", "restricted"
  
  // Worker locked-down view access
  workerViewToken: text("worker_view_token").notNull().unique(),
  workerViewMode: text("worker_view_mode").notNull().default("direct-worker"), // "direct-worker" | "drive-embed"
  allowDownload: integer("allow_download", { mode: "boolean" }).notNull().default(true),
  
  status: text("status").notNull().default("ready"), // "ready" | "failed" | "generating"
  errorMessage: text("error_message"),
  createdBy: text("created_by"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const insertPdfGenerationLogSchema = createInsertSchema(pdfGenerationLogs);
export const selectPdfGenerationLogSchema = createSelectSchema(pdfGenerationLogs);
export type PdfGenerationLog = typeof pdfGenerationLogs.$inferSelect;
export type NewPdfGenerationLog = typeof pdfGenerationLogs.$inferInsert;
