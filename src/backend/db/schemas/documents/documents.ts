/**
 * @fileoverview Postgres schema for first-class collaborative documents.
 *
 * Stores the canonical Tiptap/ProseMirror JSON document and an optimistic
 * revision counter in the Postgres system of record. API validation schemas
 * are derived from this table with drizzle-zod.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";

/** Canonical collaborative documents stored in Postgres. */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    owner: text("owner").notNull(),
    title: text("title").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("documents_owner_updated_idx").on(table.owner, table.updatedAt),
    check("documents_revision_positive", sql`${table.revision} > 0`),
  ],
);

/** Drizzle-derived document insert validator. */
export const insertDocumentSchema = createInsertSchema(documents);
/** Drizzle-derived document response validator. */
export const selectDocumentSchema = createSelectSchema(documents);
/** Drizzle-derived document patch validator. */
export const updateDocumentSchema = createUpdateSchema(documents);
export type DocumentRow = typeof documents.$inferSelect;
export type NewDocumentRow = typeof documents.$inferInsert;
