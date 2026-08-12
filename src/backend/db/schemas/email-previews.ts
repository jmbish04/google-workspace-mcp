/**
 * @file src/backend/db/schemas/email-previews.ts
 * @description Hosted email-draft previews. A model renders a draft's inlined
 * HTML and stores it here under an unguessable uuid; the worker frontend serves
 * it at `/gws/email-preview/<id>` (inside a sandboxed iframe) so the user can
 * eyeball the email before it's sent. Ephemeral — safe to prune old rows.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const emailPreviews = sqliteTable("email_previews", {
  /** Unguessable uuid (the preview URL path segment). */
  id: text("id").primaryKey(),
  subject: text("subject"),
  toAddr: text("to_addr"),
  /** The Gmail-inlined, sanitized HTML body to render. */
  html: text("html").notNull(),
  /** Account the preview was created for (display only). */
  account: text("account"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const insertEmailPreviewSchema = createInsertSchema(emailPreviews);
export const selectEmailPreviewSchema = createSelectSchema(emailPreviews);
export type EmailPreview = typeof emailPreviews.$inferSelect;
