/**
 * @fileoverview `gws.gmail_threads` — one row per Gmail thread, holding all thread metadata.
 * Messages hang off it by integer FK (`gmail_messages.thread_id`).
 */
import { index, integer, jsonb, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { gws } from "./_base";
import { accounts } from "./accounts";

export const gmailThreads = gws.table(
  "gmail_threads",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
    gmailThreadId: text("gmail_thread_id").notNull(),
    subject: text("subject"),
    snippet: text("snippet"),
    historyId: text("history_id"),
    labelIds: text("label_ids").array().notNull().default([]),
    /** The Gmail thread resource minus bodies, kept so no thread field is ever lost. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** Messages Gmail reported at last sync (drafts included). */
    gmailMessageCount: integer("gmail_message_count").notNull().default(0),
    /** Messages we hold (drafts are never stored). `gmailMessageCount - draftCount` when complete. */
    messageCount: integer("message_count").notNull().default(0),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    driveFolderId: text("drive_folder_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("gmail_threads_account_gmail_uq").on(t.accountId, t.gmailThreadId),
    index("gmail_threads_last_message_idx").on(t.accountId, t.lastMessageAt),
  ],
);

export type GmailThread = typeof gmailThreads.$inferSelect;
