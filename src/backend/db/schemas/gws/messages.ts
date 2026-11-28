/**
 * @fileoverview `gws.gmail_messages`, `gws.people`, `gws.message_participants`.
 *
 * A Gmail message never changes after it is sent (only labels do), so a stored row is
 * authoritative. Both Gmail ids and the integer FK to the thread are held.
 * People are one row per human, ever; the junction carries from/to/cc/bcc.
 */
import {
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { gws, citext } from "./_base";
import { accounts } from "./accounts";
import { gmailThreads } from "./threads";

export const gmailMessages = gws.table(
  "gmail_messages",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    threadId: integer("thread_id").notNull().references(() => gmailThreads.id, { onDelete: "cascade" }),
    accountId: integer("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
    gmailThreadId: text("gmail_thread_id").notNull(),
    gmailMessageId: text("gmail_message_id").notNull(),
    rfc822MessageId: text("rfc822_message_id"),
    inReplyTo: text("in_reply_to"),
    subject: text("subject"),
    snippet: text("snippet"),
    internalDate: timestamp("internal_date", { withTimezone: true }),
    labelIds: text("label_ids").array().notNull().default([]),
    headers: jsonb("headers").$type<Record<string, string | string[]>>().notNull().default({}),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    urls: jsonb("urls").$type<{ label: string; href: string }[]>().notNull().default([]),
    sizeBytes: integer("size_bytes"),
    /** Set when Gmail stops listing the message (deleted); cleared if it reappears. */
    goneAt: timestamp("gone_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("gmail_messages_account_gmail_uq").on(t.accountId, t.gmailMessageId),
    index("gmail_messages_thread_date_idx").on(t.threadId, t.internalDate),
  ],
);

export const people = gws.table(
  "people",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    email: citext("email").notNull(),
    displayName: text("display_name"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    organization: text("organization"),
    roleNote: text("role_note"),
    /** Agent-written facts about the person. */
    profile: jsonb("profile").$type<Record<string, unknown>>().notNull().default({}),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("people_email_uq").on(t.email)],
);

export const participantRole = gws.enum("participant_role", ["from", "to", "cc", "bcc", "reply_to"]);

export const messageParticipants = gws.table(
  "message_participants",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    messageId: integer("message_id").notNull().references(() => gmailMessages.id, { onDelete: "cascade" }),
    personId: integer("person_id").notNull().references(() => people.id, { onDelete: "restrict" }),
    role: participantRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_participants_uq").on(t.messageId, t.personId, t.role),
    index("message_participants_person_idx").on(t.personId, t.role),
  ],
);

export type GmailMessage = typeof gmailMessages.$inferSelect;
export type Person = typeof people.$inferSelect;
