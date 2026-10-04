/**
 * @fileoverview Postgres schema for tracked document suggestions.
 *
 * Suggestions are reviewable objects, separate from document content. Each
 * stores a stable editor anchor, proposed ProseMirror change, author, and
 * pending/accepted/rejected lifecycle state.
 */
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";

import { documents } from "@/backend/db/schemas/documents/documents";

/** Allowed review states for a suggestion. */
export const suggestionStatus = pgEnum("suggestion_status", ["pending", "accepted", "rejected"]);

/** First-class tracked suggestions attached to documents. */
export const suggestions = pgTable(
  "suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    author: text("author").notNull(),
    anchor: jsonb("anchor").$type<Record<string, unknown>>().notNull(),
    proposedChange: jsonb("proposed_change").$type<Record<string, unknown>>().notNull(),
    status: suggestionStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("suggestions_doc_status_idx").on(table.docId, table.status),
    index("suggestions_doc_created_idx").on(table.docId, table.createdAt),
  ],
);

/** Drizzle-derived suggestion insert validator. */
export const insertSuggestionSchema = createInsertSchema(suggestions);
/** Drizzle-derived suggestion response validator. */
export const selectSuggestionSchema = createSelectSchema(suggestions);
/** Drizzle-derived suggestion patch validator. */
export const updateSuggestionSchema = createUpdateSchema(suggestions);
export type SuggestionRow = typeof suggestions.$inferSelect;
export type NewSuggestionRow = typeof suggestions.$inferInsert;
