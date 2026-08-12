/**
 * @file src/backend/db/schemas/email-templates.ts
 * @description Reusable Gmail-safe HTML email templates — a "marketplace" of
 * inline-styled starting points. Built-in templates (seeded idempotently) give
 * the model a solid, Gmail-best-practice core; users can add their own. Managed
 * via MCP tools and a frontend gallery.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const emailTemplates = sqliteTable("email_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),
  /** Gmail-inlined HTML. May contain {{placeholders}} for the model to fill. */
  html: text("html").notNull(),
  /** True for the seeded built-in templates (not user-deletable by default). */
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdBySub: text("created_by_sub"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const insertEmailTemplateSchema = createInsertSchema(emailTemplates);
export const selectEmailTemplateSchema = createSelectSchema(emailTemplates);
export type EmailTemplate = typeof emailTemplates.$inferSelect;
