/**
 * @file drive/tags.ts
 * @description Drive tagging logic: canonical tag names, a deduplicated D1
 * registry, a many-to-many tag↔drive mapping, and syncing each tag into the
 * Drive file's `description` as a searchable `#UPPER_SNAKE` token.
 *
 * Agents should `listTags` before `createTag` so they reuse an existing tag
 * (matched by canonical name / described intent) instead of minting a near-dup.
 */
import { eq, inArray } from "drizzle-orm";

import { getDb } from "@/db";
import { driveTags, driveTagTargets, type DriveTagRow } from "@db/schemas";
import type { DriveService } from "@/backend/mcp/services/drive";

/** Canonical tag string: UPPER_SNAKE, no `#`, alnum + underscores, ≤60 chars. */
export function normalizeTagName(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** The Drive-description token for a tag name (the searchable `#TAG`). */
export function tagToken(name: string): string {
  return `#${name}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** List tags, optionally filtered by category and/or a name/description substring. */
export async function listTags(env: Env, opts: { category?: string; search?: string } = {}): Promise<DriveTagRow[]> {
  const rows = await getDb(env).select().from(driveTags);
  const cat = opts.category?.trim().toLowerCase();
  const q = opts.search?.trim().toLowerCase();
  return rows
    .filter((r) => !cat || (r.category ?? "").toLowerCase() === cat)
    .filter((r) => !q || r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Find a tag by its (normalized) name. */
export async function getTagByName(env: Env, name: string): Promise<DriveTagRow | undefined> {
  const n = normalizeTagName(name);
  return (await getDb(env).select().from(driveTags).where(eq(driveTags.name, n)).limit(1))[0];
}

/** Create a tag, or return the existing one (dedup by canonical name — never a duplicate row). */
export async function createTag(
  env: Env,
  input: { name: string; description?: string; category?: string; sub?: string },
): Promise<{ tag: DriveTagRow; created: boolean }> {
  const n = normalizeTagName(input.name);
  if (!n) throw new Error("Tag name is empty after normalization (use letters/numbers).");
  const existing = await getTagByName(env, n);
  if (existing) return { tag: existing, created: false };
  const [tag] = await getDb(env)
    .insert(driveTags)
    .values({ name: n, description: input.description ?? null, category: input.category ?? null, createdBySub: input.sub ?? null })
    .returning();
  return { tag, created: true };
}

/**
 * Apply one or more tags to a Drive file/folder: get-or-create each tag, add the
 * mapping row (idempotent), and append any missing `#TAG` tokens to the Drive
 * file's description so it's findable via the Drive API.
 */
export async function applyTags(
  env: Env,
  drive: DriveService,
  driveId: string,
  tagNames: string[],
  opts: { driveType?: "file" | "folder"; sub?: string } = {},
): Promise<{ driveId: string; applied: string[] }> {
  const db = getDb(env);
  const applied: string[] = [];
  const tokens: string[] = [];
  for (const raw of tagNames) {
    const { tag } = await createTag(env, { name: raw, sub: opts.sub });
    await db
      .insert(driveTagTargets)
      .values({ tagId: tag.id, driveId, driveType: opts.driveType ?? null, createdBySub: opts.sub ?? null })
      .onConflictDoNothing();
    applied.push(tag.name);
    tokens.push(tagToken(tag.name));
  }

  // Append only the tokens not already present in the description.
  const current = await drive.getDescription(driveId);
  const missing = tokens.filter((t) => !new RegExp(`(^|\\s)${escapeRegExp(t)}(\\s|$)`).test(current));
  if (missing.length) {
    const next = (current ? `${current.trimEnd()}\n` : "") + missing.join(" ");
    await drive.setDescription(driveId, next);
  }
  return { driveId, applied };
}

/**
 * Find Drive ids carrying the given tag(s). `mode`:
 *  - "d1" (default): from the mapping table (fast, exact).
 *  - "drive": Drive full-text search for the `#TAG` token(s) in descriptions.
 *  - "both": union of the two.
 */
export async function findByTags(
  env: Env,
  drive: DriveService,
  tagNames: string[],
  opts: { mode?: "d1" | "drive" | "both" } = {},
): Promise<{ d1: string[]; drive: string[] }> {
  const mode = opts.mode ?? "d1";
  const names = tagNames.map(normalizeTagName).filter(Boolean);
  const result: { d1: string[]; drive: string[] } = { d1: [], drive: [] };

  if (mode !== "drive" && names.length) {
    const tags = await getDb(env).select().from(driveTags).where(inArray(driveTags.name, names));
    const ids = tags.map((t) => t.id);
    if (ids.length) {
      const targets = await getDb(env).select().from(driveTagTargets).where(inArray(driveTagTargets.tagId, ids));
      result.d1 = [...new Set(targets.map((t) => t.driveId))];
    }
  }
  if (mode !== "d1" && names.length) {
    const q = names.map((n) => `fullText contains '${tagToken(n)}'`).join(" and ");
    const res = await drive.search(q, 50);
    result.drive = res.files.map((f) => f.id);
  }
  return result;
}
