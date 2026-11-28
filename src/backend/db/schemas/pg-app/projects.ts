/**
 * @fileoverview `app.projects`, `app.tasks`, `app.project_threads`, `app.project_people`.
 *
 * Projects carry the real-world matters (e.g. "Mr. Roofing"): background and context live on
 * the project, tasks record what has to be done and may point at the message that caused them.
 * Threads and people attach to a project many-to-many.
 */
import { index, integer, jsonb, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { app } from "../gws/_base";
import { gmailMessages, people } from "../gws/messages";
import { gmailThreads } from "../gws/threads";

export const projectStatus = app.enum("project_status", ["active", "archived", "on_hold"]);
export const taskStatus = app.enum("task_status", ["todo", "in_progress", "blocked", "done", "cancelled"]);

export const projects = app.table(
  "projects",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** Colby Maestro project_key when the project is tracked there. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    background: text("background"),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    status: projectStatus("status").notNull().default("active"),
    color: text("color").notNull().default("#6366f1"),
    owner: text("owner").notNull().default("you"),
    starred: integer("starred").notNull().default(0),
    /** D1 text id, kept so migrated rows and old links stay traceable. */
    legacyId: text("legacy_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("projects_key_uq").on(t.key)],
);

export const tasks = app.table(
  "tasks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: taskStatus("status").notNull().default("todo"),
    priority: text("priority"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    sourceMessageId: integer("source_message_id").references(() => gmailMessages.id, { onDelete: "set null" }),
    legacyId: text("legacy_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tasks_project_status_idx").on(t.projectId, t.status)],
);

export const projectThreads = app.table(
  "project_threads",
  {
    projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    threadId: integer("thread_id").notNull().references(() => gmailThreads.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.threadId] }), index("project_threads_thread_idx").on(t.threadId)],
);

export const projectPeople = app.table(
  "project_people",
  {
    projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    roleNote: text("role_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.personId] }), index("project_people_person_idx").on(t.personId)],
);

export type Project = typeof projects.$inferSelect;
export type Task = typeof tasks.$inferSelect;
