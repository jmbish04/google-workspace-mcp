/**
 * @file src/backend/db/schemas/email-drafts.ts
 * @description The draft studio: an email revised on the worker frontend
 * instead of in Gmail.
 *
 * Gmail drafts are a bad place to iterate — the model spends a round trip
 * finding and rewriting the draft each time, and nothing records what changed.
 * A studio draft lives here instead: the agent pushes a new REVISION, the open
 * page updates over its WebSocket, the human can edit it in PlateJS or leave
 * comments on a highlighted passage, and only when it is right does it become a
 * Gmail draft or get sent.
 *
 * Revisions are append-only, so the diff between any two is always available
 * and nothing a previous version said is lost.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const EMAIL_DRAFTS_TABLE_DESCRIPTION =
  "Emails being drafted on the worker frontend (the draft studio) rather than in Gmail. One row per draft; the body lives in email_draft_revisions.";

export const EMAIL_DRAFT_STATUSES = ["drafting", "in_gmail", "sent", "discarded"] as const;
export type EmailDraftStatus = (typeof EMAIL_DRAFT_STATUSES)[number];

export const emailDrafts = sqliteTable(
  "email_drafts",
  {
    id: text("id").primaryKey(),
    /** Account reference the draft will be sent from. */
    account: text("account"),
    /** Comma-separated recipients, as they go into the MIME headers. */
    toAddr: text("to_addr"),
    ccAddr: text("cc_addr"),
    bccAddr: text("bcc_addr"),
    subject: text("subject"),
    /** Reply context: the Gmail message this draft answers, if any. */
    replyToMessageId: text("reply_to_message_id"),
    threadId: text("thread_id"),
    status: text("status").$type<EmailDraftStatus>().notNull().default("drafting"),
    /** Revision number currently shown and sent — always the highest. */
    currentRevision: integer("current_revision").notNull().default(0),
    /** Hidden reference id stamped into the body when it is finally sent. */
    uuid: text("uuid"),
    /** Set once promoted to a real Gmail draft. */
    gmailDraftId: text("gmail_draft_id"),
    /** Set once sent. */
    sentMessageId: text("sent_message_id"),
    createdBySub: text("created_by_sub"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("email_drafts_status_idx").on(t.status, t.updatedAt)],
);

export const EMAIL_DRAFT_REVISIONS_TABLE_DESCRIPTION =
  "Append-only body history for a studio draft. `html` is the Gmail-ready body exactly as it would be sent.";

export const emailDraftRevisions = sqliteTable(
  "email_draft_revisions",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id").notNull(),
    /** 1-based, monotonic per draft. */
    n: integer("n").notNull(),
    /** The Gmail-native, inlined HTML body — what the recipient would see. */
    html: text("html").notNull(),
    /** Plain-text alternative derived from the html. */
    text: text("text").notNull(),
    /** Who produced this revision. */
    source: text("source").$type<"agent" | "human">().notNull(),
    /** One line on what changed, shown beside the revision in the UI. */
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("email_draft_revisions_draft_n_idx").on(t.draftId, t.n)],
);

export const EMAIL_DRAFT_COMMENTS_TABLE_DESCRIPTION =
  "Notes the human left on a studio draft — optionally anchored to a highlighted passage — for the agent to act on.";

export const emailDraftComments = sqliteTable(
  "email_draft_comments",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id").notNull(),
    /** Revision the comment was made against. */
    revision: integer("revision").notNull(),
    /** The highlighted passage, or null for a comment on the whole draft. */
    quote: text("quote"),
    body: text("body").notNull(),
    resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("email_draft_comments_draft_idx").on(t.draftId, t.resolved)],
);

export const insertEmailDraftSchema = createInsertSchema(emailDrafts);
export const selectEmailDraftSchema = createSelectSchema(emailDrafts);
export const insertEmailDraftRevisionSchema = createInsertSchema(emailDraftRevisions);
export const selectEmailDraftRevisionSchema = createSelectSchema(emailDraftRevisions);
export const insertEmailDraftCommentSchema = createInsertSchema(emailDraftComments);
export const selectEmailDraftCommentSchema = createSelectSchema(emailDraftComments);

export type EmailDraft = typeof emailDrafts.$inferSelect;
export type EmailDraftRevision = typeof emailDraftRevisions.$inferSelect;
export type EmailDraftComment = typeof emailDraftComments.$inferSelect;
