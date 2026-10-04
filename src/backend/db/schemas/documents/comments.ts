/**
 * @fileoverview Postgres schema for anchored document comment threads.
 *
 * Comments retain editor anchors independently of document content and use a
 * thread UUID plus an optional parent comment to model replies. Resolution is
 * explicit and queryable rather than encoded in chat text.
 */
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";

import { documents } from "@/backend/db/schemas/documents/documents";

/** First-class anchored document comments and replies. */
export const comments = pgTable(
  "document_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    author: text("author").notNull(),
    anchor: jsonb("anchor").$type<Record<string, unknown>>().notNull(),
    body: text("body").notNull(),
    threadId: uuid("thread_id").notNull().defaultRandom(),
    parentId: uuid("parent_id"),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("document_comments_doc_resolved_idx").on(table.docId, table.resolved),
    index("document_comments_thread_idx").on(table.threadId, table.createdAt),
  ],
);

/** Drizzle-derived comment insert validator. */
export const insertCommentSchema = createInsertSchema(comments);
/** Drizzle-derived comment response validator. */
export const selectCommentSchema = createSelectSchema(comments);
/** Drizzle-derived comment patch validator. */
export const updateCommentSchema = createUpdateSchema(comments);
export type CommentRow = typeof comments.$inferSelect;
export type NewCommentRow = typeof comments.$inferInsert;
