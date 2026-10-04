/**
 * @fileoverview Typed Postgres persistence operations for collaborative documents.
 *
 * Opens one Hyperdrive/Postgres.js client per operation, executes Drizzle
 * queries against the Postgres-only schema, and always closes the client.
 */
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";

import { getSql } from "@/backend/db/postgres";
import * as schema from "@/backend/db/postgres-schema";
import {
  comments,
  documents,
  suggestions,
  type NewCommentRow,
  type NewDocumentRow,
  type NewSuggestionRow,
} from "@/backend/db/schemas/documents";

async function useDb<T>(
  env: Env,
  operation: (db: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>,
): Promise<T> {
  const sql = getSql(env);
  try {
    return await operation(drizzle(sql, { schema }));
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/** Persistence facade used by the document API. */
export class DocumentStore {
  /** @param env - Worker bindings containing Hyperdrive. */
  constructor(private readonly env: Env) {}

  /** @returns Documents newest-first, optionally scoped to an owner. */
  listDocuments(owner?: string) {
    return useDb(this.env, (db) =>
      db
        .select()
        .from(documents)
        .where(owner ? eq(documents.owner, owner) : undefined)
        .orderBy(desc(documents.updatedAt)),
    );
  }
  /** @param id - Document UUID. @returns The document or undefined. */
  getDocument(id: string) {
    return useDb(
      this.env,
      async (db) => (await db.select().from(documents).where(eq(documents.id, id)).limit(1))[0],
    );
  }
  /** @param value - Validated document values. @returns The created document. */
  createDocument(value: NewDocumentRow) {
    return useDb(
      this.env,
      async (db) => (await db.insert(documents).values(value).returning())[0]!,
    );
  }
  /** @param id - Document UUID. @param value - Validated patch. @returns Updated document or undefined. */
  updateDocument(id: string, value: Partial<NewDocumentRow>) {
    return useDb(
      this.env,
      async (db) =>
        (
          await db
            .update(documents)
            .set({ ...value, updatedAt: new Date() })
            .where(eq(documents.id, id))
            .returning()
        )[0],
    );
  }
  /** @param id - Document UUID. @returns True when a row was deleted. */
  deleteDocument(id: string) {
    return useDb(
      this.env,
      async (db) =>
        (await db.delete(documents).where(eq(documents.id, id)).returning({ id: documents.id }))
          .length === 1,
    );
  }

  /** @param docId - Parent document UUID. @param status - Optional review state. @returns Matching suggestions. */
  listSuggestions(docId: string, status?: "pending" | "accepted" | "rejected") {
    return useDb(this.env, (db) =>
      db
        .select()
        .from(suggestions)
        .where(
          and(eq(suggestions.docId, docId), status ? eq(suggestions.status, status) : undefined),
        )
        .orderBy(desc(suggestions.createdAt)),
    );
  }
  /** @param id - Suggestion UUID. @returns The suggestion or undefined. */
  getSuggestion(id: string) {
    return useDb(
      this.env,
      async (db) => (await db.select().from(suggestions).where(eq(suggestions.id, id)).limit(1))[0],
    );
  }
  /** @param value - Validated suggestion values. @returns Created suggestion. */
  createSuggestion(value: NewSuggestionRow) {
    return useDb(
      this.env,
      async (db) => (await db.insert(suggestions).values(value).returning())[0]!,
    );
  }
  /** @param id - Suggestion UUID. @param value - Validated patch. @returns Updated suggestion or undefined. */
  updateSuggestion(id: string, value: Partial<NewSuggestionRow>) {
    return useDb(
      this.env,
      async (db) =>
        (
          await db
            .update(suggestions)
            .set({ ...value, updatedAt: new Date() })
            .where(eq(suggestions.id, id))
            .returning()
        )[0],
    );
  }
  /** @param id - Suggestion UUID. @returns True when deleted. */
  deleteSuggestion(id: string) {
    return useDb(
      this.env,
      async (db) =>
        (
          await db
            .delete(suggestions)
            .where(eq(suggestions.id, id))
            .returning({ id: suggestions.id })
        ).length === 1,
    );
  }

  /** @param docId - Parent document UUID. @param resolved - Optional resolution filter. @returns Matching comments. */
  listComments(docId: string, resolved?: boolean) {
    return useDb(this.env, (db) =>
      db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.docId, docId),
            resolved === undefined ? undefined : eq(comments.resolved, resolved),
          ),
        )
        .orderBy(comments.threadId, comments.createdAt),
    );
  }
  /** @param id - Comment UUID. @returns The comment or undefined. */
  getComment(id: string) {
    return useDb(
      this.env,
      async (db) => (await db.select().from(comments).where(eq(comments.id, id)).limit(1))[0],
    );
  }
  /** @param value - Validated comment values. @returns Created comment. */
  createComment(value: NewCommentRow) {
    return useDb(this.env, async (db) => (await db.insert(comments).values(value).returning())[0]!);
  }
  /** @param id - Comment UUID. @param value - Validated patch. @returns Updated comment or undefined. */
  updateComment(id: string, value: Partial<NewCommentRow>) {
    return useDb(
      this.env,
      async (db) =>
        (
          await db
            .update(comments)
            .set({ ...value, updatedAt: new Date() })
            .where(eq(comments.id, id))
            .returning()
        )[0],
    );
  }
  /** @param id - Comment UUID. @returns True when deleted. */
  deleteComment(id: string) {
    return useDb(
      this.env,
      async (db) =>
        (await db.delete(comments).where(eq(comments.id, id)).returning({ id: comments.id }))
          .length === 1,
    );
  }

  /** @returns True when Postgres answers a trivial query. */
  health() {
    return useDb(this.env, async (db) => {
      await db.execute("select 1");
      return true;
    });
  }
}
