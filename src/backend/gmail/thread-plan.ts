/**
 * @file gmail/thread-plan.ts
 * @description Pure reconcile logic for the thread cache. Given what Gmail says a
 * thread holds (`format=minimal`) and what D1 already stores, decide which
 * messages to fetch, which labels changed, and which cached messages vanished.
 * No network, no DB: the sync in thread-index.ts feeds it and acts on the result.
 *
 * Why a plan: a Gmail message never changes once sent (only its labels do), so
 * the second pull of a 15-message thread should fetch 0 bodies, and the pull after
 * a new reply should fetch exactly 1.
 */
import type { AttachmentPart } from "./attachments";

/** One message in Gmail's thread skeleton. */
export interface MetaMessage {
  id: string;
  labelIds?: string[];
}

/** What we keep about a cached message. */
export interface CachedMessage {
  id: string;
  labelIds: string[] | null;
  /** False for rows from the label scan, which never stored headers/urls. */
  hydrated: boolean;
  goneAt: number | null;
}

export interface ThreadPlan {
  /** Messages Gmail reports, drafts included. */
  gmailCount: number;
  /** Not stored yet, or stored without headers: fetch in full and store. */
  toFetch: string[];
  /** Drafts are rewritten on every edit, so they are read live and never stored. */
  drafts: string[];
  /** Stored messages whose labels differ from Gmail's now. */
  labelUpdates: { id: string; labelIds: string[] }[];
  /** Stored, still active, but Gmail no longer lists them. */
  gone: string[];
  /** Stored as gone, but Gmail lists them again. */
  revived: string[];
}

const same = (a: string[] | null, b: string[]) => {
  if (!a || a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
};

/** Diff Gmail's skeleton against the cache. */
export function planThreadSync(meta: MetaMessage[], cached: CachedMessage[]): ThreadPlan {
  const byId = new Map(cached.map((c) => [c.id, c]));
  const listed = new Set(meta.map((m) => m.id));
  const plan: ThreadPlan = {
    gmailCount: meta.length,
    toFetch: [],
    drafts: [],
    labelUpdates: [],
    gone: [],
    revived: [],
  };

  for (const m of meta) {
    const labels = m.labelIds ?? [];
    if (labels.includes("DRAFT")) {
      plan.drafts.push(m.id);
      continue;
    }
    const have = byId.get(m.id);
    if (!have || !have.hydrated) {
      plan.toFetch.push(m.id);
      continue;
    }
    if (have.goneAt != null) plan.revived.push(m.id);
    if (!same(have.labelIds, labels)) plan.labelUpdates.push({ id: m.id, labelIds: labels });
  }

  for (const c of cached) if (!listed.has(c.id) && c.goneAt == null) plan.gone.push(c.id);
  return plan;
}

/** What the sync reports back, so the caller can see the cache is complete. */
export interface IndexStatus {
  /** Messages Gmail reports for the thread (drafts included). */
  gmailCount: number;
  /** Messages we now hold (drafts are never stored). */
  indexedCount: number;
  /** Draft messages, read live. */
  drafts: number;
  /** Fetched and stored on this call. */
  newlyIndexed: number;
  /** Still missing: over the per-call cap, or the fetch failed. */
  pending: number;
  /** indexedCount + drafts === gmailCount. */
  complete: boolean;
  fetchErrors: { id: string; error: string }[];
  syncedAt: number;
}

export function indexStatus(
  plan: ThreadPlan,
  r: { stored: number; fetched: number; errors: { id: string; error: string }[]; now: number },
): IndexStatus {
  const nonDraft = plan.gmailCount - plan.drafts.length;
  const pending = nonDraft - r.stored;
  return {
    gmailCount: plan.gmailCount,
    indexedCount: r.stored,
    drafts: plan.drafts.length,
    newlyIndexed: r.fetched,
    pending,
    complete: pending === 0,
    fetchErrors: r.errors,
    syncedAt: r.now,
  };
}

// ---------------------------------------------------------------------------
// Attachment registry
// ---------------------------------------------------------------------------

export interface ExistingAttachmentRow {
  id: string;
  partId: string | null;
  filename: string | null;
  size: number | null;
}

/**
 * Decide, per attachment part of a message, whether to insert a registry row,
 * or adopt a row the label scan wrote earlier (it recorded no partId, so we match
 * on filename + size and stamp the partId onto it instead of duplicating).
 */
export function planAttachmentRows(
  existing: ExistingAttachmentRow[],
  parts: AttachmentPart[],
): { insert: AttachmentPart[]; adopt: { id: string; part: AttachmentPart }[] } {
  const byPart = new Set(existing.filter((e) => e.partId).map((e) => e.partId));
  const legacy = existing.filter((e) => !e.partId);
  const insert: AttachmentPart[] = [];
  const adopt: { id: string; part: AttachmentPart }[] = [];
  for (const part of parts) {
    if (part.partId && byPart.has(part.partId)) continue;
    const i = legacy.findIndex((e) => e.filename === (part.filename || null) && e.size === part.size);
    if (i >= 0) adopt.push({ id: legacy.splice(i, 1)[0].id, part });
    else insert.push(part);
  }
  return { insert, adopt };
}
