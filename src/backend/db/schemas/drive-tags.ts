/**
 * @file db/schemas/drive-tags.ts
 * @description Drive tagging: a deduplicated tag REGISTRY (`drive_tags`) plus a
 * many-to-many MAPPING (`drive_tag_targets`) between tags and Drive file/folder
 * ids. Agents query the registry before creating a tag (so they reuse an
 * existing one instead of spawning near-duplicates), and each applied tag is
 * ALSO written into the Drive file's description as `#UPPER_SNAKE` so the same
 * tag is findable via the Drive API's full-text search.
 */
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/** The tag registry — one row per distinct tag, name is the canonical UPPER_SNAKE. */
export const driveTags = sqliteTable(
  "drive_tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Canonical tag string (UPPER_SNAKE, no `#`), unique. */
    name: text("name").notNull(),
    /** What the tag means — shown to agents deciding whether to reuse it. */
    description: text("description"),
    /** Coarse bucket for filtering: e.g. "project" | "scenario" | "topic". */
    category: text("category"),
    createdBySub: text("created_by_sub"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => ({ nameUnique: uniqueIndex("drive_tags_name_unique").on(t.name) }),
);

/** Many-to-many: which Drive files/folders carry which tag. */
export const driveTagTargets = sqliteTable(
  "drive_tag_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tagId: integer("tag_id").notNull(),
    /** Drive file OR folder id. */
    driveId: text("drive_id").notNull(),
    /** "file" | "folder" (best-effort; informational). */
    driveType: text("drive_type"),
    createdBySub: text("created_by_sub"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => ({ tagTargetUnique: uniqueIndex("drive_tag_targets_unique").on(t.tagId, t.driveId) }),
);

export const insertDriveTagSchema = createInsertSchema(driveTags);
export const selectDriveTagSchema = createSelectSchema(driveTags);
export type DriveTagRow = typeof driveTags.$inferSelect;
export type DriveTagTargetRow = typeof driveTagTargets.$inferSelect;
