/**
 * @fileoverview `gws.content_chunks` — embedded + full-text-searchable pieces of message
 * bodies and of extracted/OCR document text. Exactly one of `message_id` / `content_id`.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, text, timestamp, vector } from "drizzle-orm/pg-core";
import { gws, EMBEDDING_DIMS, tsvector } from "./_base";
import { fileContents } from "./files";
import { gmailMessages } from "./messages";

export const contentChunks = gws.table(
  "content_chunks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    messageId: integer("message_id").references(() => gmailMessages.id, { onDelete: "cascade" }),
    contentId: integer("content_id").references(() => fileContents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMS }),
    /** Maintained by a trigger in the migration (see 0001 custom SQL), never by the app. */
    tsv: tsvector("tsv"),
    /** Model that produced `embedding`; a different model means a re-embed. */
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "content_chunks_one_owner",
      sql`(${t.messageId} IS NOT NULL AND ${t.contentId} IS NULL) OR (${t.messageId} IS NULL AND ${t.contentId} IS NOT NULL)`,
    ),
    index("content_chunks_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("content_chunks_tsv_gin").using("gin", t.tsv),
    index("content_chunks_message_idx").on(t.messageId, t.chunkIndex),
    index("content_chunks_content_idx").on(t.contentId, t.chunkIndex),
  ],
);

export type ContentChunk = typeof contentChunks.$inferSelect;
