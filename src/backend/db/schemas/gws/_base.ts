/**
 * @fileoverview Shared Postgres building blocks for the Gmail/Drive store (schema `gws`)
 * and the project/task store (schema `app`).
 *
 * Why two Postgres schemas: `app.tasks`/`app.projects` would otherwise collide with names
 * the D1 template already uses, and `gws` keeps the mailbox store separable (backup, grants).
 * Design: docs/gmail-postgres-plan.md. Drizzle cannot mix SQLite and Postgres in one
 * migration target, so these live behind `postgres-schema.ts`, never the D1 barrel.
 */
import { customType, pgSchema } from "drizzle-orm/pg-core";

/** Mailbox store: threads, messages, people, attachments, chunks, notes, rules, queue. */
export const gws = pgSchema("gws");
/** Project/task store carried over from the D1 template, plus project<->thread links. */
export const app = pgSchema("app");

/**
 * Embedding width. Fixed by the model chosen in plan decision D3
 * (text-embedding-3-large cut to 1024 dims through Core Guardian). Each chunk also
 * records `model`, so changing models means re-embedding, never a schema change.
 */
export const EMBEDDING_DIMS = 1024;

/** Case-insensitive text (extension `citext`). Used for email addresses. */
export const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

/** Full-text search vector. Populated by the database, never written by the app. */
export const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});
