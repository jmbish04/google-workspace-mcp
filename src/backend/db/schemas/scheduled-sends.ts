/**
 * @file src/backend/db/schemas/scheduled-sends.ts
 * @description Queue for scheduled Gmail sends. A row pins a Gmail DRAFT to a
 * cron string (UTC); an hourly worker cron sweeps unsent rows and, when a cron
 * occurrence has passed, sends the draft and flips `sent`. One-shot: once sent,
 * the row is done (a recurring cron still only fires the single stored draft).
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const scheduledSends = sqliteTable(
  "scheduled_sends",
  {
    /** Autoincrement surrogate key. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The Gmail draft id to send when due. */
    draftId: text("draft_id").notNull(),
    /** Token ref used to send (dwd:email or a signed-in sub) — the drafting account. */
    accountRef: text("account_ref").notNull(),
    /** Human-readable account email (for listing/audit). */
    accountEmail: text("account_email"),
    /** 5-field cron string (UTC) governing when to send. */
    cron: text("cron").notNull(),
    /** Whether the draft has been sent. */
    sent: integer("sent", { mode: "boolean" }).notNull().default(false),
    /** Gmail message id produced by the send. */
    sentMessageId: text("sent_message_id"),
    /** Last time the sweep evaluated this row (epoch ms), for the cron window. */
    lastCheckedAt: integer("last_checked_at"),
    /** Error from the most recent failed send attempt. */
    error: text("error"),
    /** When the schedule was created. */
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    /** When the draft was actually sent. */
    sentAt: integer("sent_at", { mode: "timestamp" }),
  },
  (t) => [index("idx_scheduled_sends_pending").on(t.sent)],
);

export const insertScheduledSendSchema = createInsertSchema(scheduledSends);
export const selectScheduledSendSchema = createSelectSchema(scheduledSends);
export type ScheduledSend = typeof scheduledSends.$inferSelect;
export type NewScheduledSend = typeof scheduledSends.$inferInsert;
