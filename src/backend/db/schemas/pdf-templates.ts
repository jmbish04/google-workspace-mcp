/**
 * @file src/backend/db/schemas/pdf-templates.ts
 * @description PDF template registry for pdfme schemas, sample data, and metadata.
 * Contains both built-in seed templates and user-created custom templates.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const pdfTemplates = sqliteTable("pdf_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull().default("general"),
  /** JSON string containing { basePdf, schemas: [[...]], pdfmeVersion? } */
  schemaJson: text("schema_json").notNull(),
  /** Sample input JSON array for preview and test rendering */
  sampleDataJson: text("sample_data_json"),
  /** Optional thumbnail or preview image URL */
  thumbnailUrl: text("thumbnail_url"),
  /** True for built-in system templates */
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdBy: text("created_by"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const insertPdfTemplateSchema = createInsertSchema(pdfTemplates);
export const selectPdfTemplateSchema = createSelectSchema(pdfTemplates);
export type PdfTemplate = typeof pdfTemplates.$inferSelect;
export type NewPdfTemplate = typeof pdfTemplates.$inferInsert;
