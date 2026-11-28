/**
 * @fileoverview Postgres-only Drizzle schema barrel.
 *
 * This is intentionally separate from the legacy D1 schema barrel: Drizzle
 * cannot mix SQLite and Postgres table definitions in one migration target.
 */
export * from "@/backend/db/schemas/documents";
export * from "@/backend/db/schemas/gws";
export * from "@/backend/db/schemas/pg-app";
