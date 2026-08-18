/**
 * @file src/backend/db/schemas/sheet-export-jobs.ts
 * @description Audit log for the spreadsheet→JSON export utility (mcp tool
 * `sheets_export_json`). One row per requested sheet (an array export writes many
 * rows), recording what was asked for, which registered account actually owned
 * the sheet, and where the exported JSON landed (Drive id / view url / download
 * url), so a run can be reviewed and re-fetched later.
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const sheetExportJobs = sqliteTable(
  "sheet_export_jobs",
  {
    /** Autoincrement surrogate key. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** UUID grouping every row produced by a single export call (one tool invocation). */
    requestId: text("request_id").notNull(),
    /** The original ref the caller passed (a Drive id OR a full Drive/Sheets url). */
    requestedRef: text("requested_ref").notNull(),
    /** The bare spreadsheet id extracted from `requestedRef`. */
    spreadsheetId: text("spreadsheet_id").notNull(),
    /** SHA-256 (hex) of the exported JSON bytes — lets us detect identical exports later. */
    jsonSha256: text("json_sha256"),
    /** The source spreadsheet's Drive modifiedTime at export — which revision was live. */
    sourceModifiedTime: text("source_modified_time"),
    /** Email of the registered account the sheet was read from (the account that had access). */
    sourceAccount: text("source_account"),
    /** JSON array of account emails tried before one succeeded (or all, on failure). */
    triedAccounts: text("tried_accounts", { mode: "json" }).$type<string[]>(),
    /** "done" | "error". */
    status: text("status").notNull(),
    /** Number of tabs captured into the JSON. */
    tabCount: integer("tab_count"),
    /** Drive id of the exported JSON file. */
    jsonDriveId: text("json_drive_id"),
    /** Drive webViewLink of the exported JSON file. */
    jsonDriveUrl: text("json_drive_url"),
    /** Direct download url (getDownloadUrl) of the exported JSON file. */
    jsonDownloadUrl: text("json_download_url"),
    /** Error message when `status = "error"`. */
    error: text("error"),
    /** Unix-epoch timestamp of the export attempt. */
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("idx_sheet_export_spreadsheet").on(t.spreadsheetId),
    index("idx_sheet_export_request").on(t.requestId),
  ],
);

export const insertSheetExportJobSchema = createInsertSchema(sheetExportJobs);
export const selectSheetExportJobSchema = createSelectSchema(sheetExportJobs);
export type SheetExportJob = typeof sheetExportJobs.$inferSelect;
export type NewSheetExportJob = typeof sheetExportJobs.$inferInsert;
