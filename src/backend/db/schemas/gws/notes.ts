/**
 * @fileoverview `gws.notes` — agent notes on a thread, a message or an attachment.
 * One row per note, any number per target. CHECK: an attachment note must also name its message.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, text, timestamp } from "drizzle-orm/pg-core";
import { gws } from "./_base";
import { gmailAttachments } from "./files";
import { gmailMessages } from "./messages";
import { gmailThreads } from "./threads";

export const notes = gws.table(
  "notes",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    threadId: integer("thread_id").notNull().references(() => gmailThreads.id, { onDelete: "cascade" }),
    messageId: integer("message_id").references(() => gmailMessages.id, { onDelete: "cascade" }),
    attachmentId: integer("attachment_id").references(() => gmailAttachments.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    author: text("author").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("notes_attachment_needs_message", sql`${t.attachmentId} IS NULL OR ${t.messageId} IS NOT NULL`),
    check("notes_body_not_blank", sql`length(btrim(${t.body})) > 0`),
    index("notes_thread_idx").on(t.threadId, t.createdAt),
    index("notes_message_idx").on(t.messageId),
    index("notes_attachment_idx").on(t.attachmentId),
  ],
);

export type Note = typeof notes.$inferSelect;
