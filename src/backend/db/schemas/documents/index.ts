/**
 * @fileoverview Barrel exports for the Postgres collaborative-document model.
 *
 * Consumers should import these tables and their drizzle-zod validators via
 * this module so document persistence remains one cohesive domain.
 */
export * from "@/backend/db/schemas/documents/documents";
export * from "@/backend/db/schemas/documents/suggestions";
export * from "@/backend/db/schemas/documents/comments";
