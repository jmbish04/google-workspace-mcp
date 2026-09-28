/**
 * @file db/schemas/email-records.ts
 * @description Every outgoing email the worker creates (draft / reply / send) is
 * logged here with a stable UUID that is ALSO embedded (hidden, white text) at
 * the bottom of the message body. This lets an agent (a) disambiguate the
 * duplicate drafts a revision loop can leave behind, and (b) recall the exact
 * Gmail thread later by UUID/subject/date without re-reading a pile of mail.
 */
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const emailRecords = sqliteTable(
  "email_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Stable id embedded in the body (hidden) + used for exact recall. */
    uuid: text("uuid").notNull(),
    /** Sending/drafting account email. */
    account: text("account"),
    /** "draft" | "reply_draft" | "send". */
    action: text("action").notNull(),
    subject: text("subject"),
    /** Recipients: { to, cc?, bcc? } as JSON. */
    recipients: text("recipients", { mode: "json" }).$type<{ to?: string; cc?: string; bcc?: string }>(),
    /** Body as supplied (markdown/html/text — whatever the caller sent). */
    body: text("body"),
    /** Gmail thread id, when known. */
    threadId: text("thread_id"),
    /** Gmail message OR draft id returned by the API. */
    messageId: text("message_id"),
    createdBySub: text("created_by_sub"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => ({ uuidIdx: uniqueIndex("email_records_uuid_unique").on(t.uuid) }),
);

export const insertEmailRecordSchema = createInsertSchema(emailRecords);
export const selectEmailRecordSchema = createSelectSchema(emailRecords);
export type EmailRecordRow = typeof emailRecords.$inferSelect;
