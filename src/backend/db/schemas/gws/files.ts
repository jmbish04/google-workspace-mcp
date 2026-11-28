/**
 * @fileoverview `gws.file_contents`, `gws.gmail_attachments`, `gws.drive_files`.
 *
 * `file_contents` is the dedupe anchor: one row per distinct byte string (sha256).
 * Every attachment gets a `gmail_attachments` row; a duplicate points at the existing
 * `file_contents` row so it is recorded but never reprocessed. Junk (signature images,
 * social icons) is recorded with `is_junk` and skipped.
 */
import { boolean, index, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { gws } from "./_base";
import { accounts } from "./accounts";
import { gmailMessages } from "./messages";

export const extractionMethod = gws.enum("extraction_method", ["pdf_text", "ocr", "docling", "office_md", "plain"]);
export const attachmentStatus = gws.enum("attachment_status", [
  "pending",
  "staged",
  "extracted",
  "embedded",
  "skipped_junk",
  "error",
]);

export const fileContents = gws.table(
  "file_contents",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes"),
    mimeType: text("mime_type"),
    extractedText: text("extracted_text"),
    extractionMethod: extractionMethod("extraction_method"),
    pageCount: integer("page_count"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("file_contents_sha256_uq").on(t.sha256)],
);

export const gmailAttachments = gws.table(
  "gmail_attachments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    messageId: integer("message_id").notNull().references(() => gmailMessages.id, { onDelete: "cascade" }),
    /** Stable across fetches. `gmailAttachmentId` is not, so identity is (message, part). */
    gmailPartId: text("gmail_part_id").notNull(),
    gmailAttachmentId: text("gmail_attachment_id"),
    filename: text("filename"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    md5: text("md5"),
    isJunk: boolean("is_junk").notNull().default(false),
    junkReason: text("junk_reason"),
    contentId: integer("content_id").references(() => fileContents.id, { onDelete: "set null" }),
    driveFileId: text("drive_file_id"),
    driveUrl: text("drive_url"),
    /** Office attachments: the Google-native copy made by conversion. */
    googleDriveId: text("google_drive_id"),
    googleMimeType: text("google_mime_type"),
    status: attachmentStatus("status").notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("gmail_attachments_message_part_uq").on(t.messageId, t.gmailPartId),
    index("gmail_attachments_sha_idx").on(t.sha256),
    index("gmail_attachments_status_idx").on(t.status),
  ],
);

export const driveFiles = gws.table(
  "drive_files",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
    driveFileId: text("drive_file_id").notNull(),
    name: text("name"),
    mimeType: text("mime_type"),
    parentDriveId: text("parent_drive_id"),
    md5: text("md5"),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),
    contentId: integer("content_id").references(() => fileContents.id, { onDelete: "set null" }),
    indexed: boolean("indexed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("drive_files_account_drive_uq").on(t.accountId, t.driveFileId)],
);

export type GmailAttachment = typeof gmailAttachments.$inferSelect;
export type FileContent = typeof fileContents.$inferSelect;
