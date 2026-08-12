/**
 * @file src/backend/db/schemas/scheduled-emails.ts
 * @description Worker-side queue for scheduled email sends. Gmail's API has NO
 * native scheduled send (`messages.send`/`drafts.send` are immediate; the "Schedule
 * send" UI feature is not exposed over the API), so we persist the FULL send spec
 * plus an absolute `send_at` instant and send it ourselves when due.
 *
 * A row is claimed ATOMICALLY (conditional update scheduled/error → sending) so
 * overlapping scheduler ticks cannot double-send. On failure the row goes to
 * `error` (retried while `attempts < MAX` and still due), never silently dropped.
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/** The complete, self-contained message spec persisted for a scheduled send. */
export interface ScheduledEmailSpec {
  to: string;
  subject: string;
  body?: string;
  html?: string;
  markdown?: string;
  /** Prefer Drive file ids (re-fetched at send time) over large inline blobs. */
  attachments?: unknown[];
  driveIds?: string[];
  blobs?: { filename: string; mimeType?: string; contentBase64: string }[];
}

export const scheduledEmails = sqliteTable(
  "scheduled_emails",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Token ref used to send (dwd:email or signed-in sub). */
    accountRef: text("account_ref").notNull(),
    /** Human-readable sending account email. */
    accountEmail: text("account_email"),
    /** The full send spec (to/subject/body/html/attachments) as JSON. */
    spec: text("spec", { mode: "json" }).$type<ScheduledEmailSpec>().notNull(),
    /** Absolute instant to send at (stored from the caller's ISO-8601 UTC `send_at`). */
    sendAt: integer("send_at", { mode: "timestamp" }).notNull(),
    /** scheduled | sending | sent | error | canceled. */
    status: text("status").notNull().default("scheduled"),
    /** Gmail message id once sent. */
    messageId: text("message_id"),
    /** Most recent send error (kept visible; the row stays retryable). */
    error: text("error"),
    /** Send attempts so far (bounded to stop infinite retries on permanent errors). */
    attempts: integer("attempts").notNull().default(0),
    /** When the row was last claimed (set to 'sending'); lets a stale claim be reclaimed after a crash. */
    claimedAt: integer("claimed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    sentAt: integer("sent_at", { mode: "timestamp" }),
  },
  (t) => [index("idx_scheduled_emails_due").on(t.status, t.sendAt)],
);

export const insertScheduledEmailSchema = createInsertSchema(scheduledEmails);
export const selectScheduledEmailSchema = createSelectSchema(scheduledEmails);
export type ScheduledEmail = typeof scheduledEmails.$inferSelect;
export type NewScheduledEmail = typeof scheduledEmails.$inferInsert;
