/**
 * @fileoverview Standing Workspace Events subscriptions over real Drive folders.
 *
 * ## The problem this solves
 *
 * Before this module, the ONLY code path that ever created a Workspace Events
 * subscription was the E2E probe, against a folder it created seconds earlier
 * and deleted at the end. Measured 2026-09-28: all 35 rows ever written to
 * `drive_notifications` were probe traffic, subscription-expiry notices, or
 * pushes from an unrelated project — not one event from real Drive activity,
 * and zero live subscriptions on either account.
 *
 * ## Why it looks the way it does
 *
 * Three measured constraints shape every decision here:
 *
 *  1. **My Drive root cannot be subscribed.** `//drive.googleapis.com/files/root`
 *     returns `400 Request contains an invalid argument` and
 *     `//drive.googleapis.com/drives/<rootId>` returns `403 Permission denied`.
 *     So coverage is one subscription per TOP-LEVEL folder with
 *     `includeDescendants: true`, not one subscription for everything.
 *     Corollary the operator accepted: files sitting loose in My Drive root
 *     (~2,025 of them across both accounts) are NOT watched, because nothing
 *     can watch them short of one subscription per file.
 *  2. **Max TTL is 7 days**, and only 4 hours if the payload carries resource
 *     data — hence `includeResource: false` below, which is load-bearing, not
 *     a default. Renewal is a cron, not a setup step.
 *  3. **One subscription per target resource per user.** A second create on the
 *     same folder returns ALREADY_EXISTS, so this is create-OR-renew and it
 *     remembers what it made in `workspace_subscriptions`.
 *
 * Writes are capped at 100/min/user by Google, so the sweep paces itself.
 */

import { eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { googleAccounts, workspaceSubscriptions } from "@db/schemas";
import { DriveService } from "@/backend/mcp/services/drive";
import { WorkspaceEventsService } from "@/backend/mcp/services/workspaceevents";
import { listCaptureAccounts } from "@/backend/gmail/sync-service";

import { DEFAULT_PUBSUB_TOPIC } from "./e2e";

/**
 * CloudEvent types each folder subscription asks for. Kept resource-free
 * (`includeResource: false`) so the subscription can hold the 7-day maximum
 * TTL rather than 4 hours.
 */
export const WATCHED_EVENT_TYPES = [
  "google.workspace.drive.file.v3.created",
  "google.workspace.drive.file.v3.contentChanged",
  "google.workspace.drive.file.v3.deleted",
  "google.workspace.drive.comment.v3.created",
] as const;

/** Renew once a subscription is within this window of expiring. */
const RENEW_BEFORE_MS = 48 * 60 * 60 * 1000;

/** Google allows 100 subscription writes per minute per user. Stay under it. */
const WRITES_PER_MINUTE = 90;
const WRITE_SPACING_MS = Math.ceil(60_000 / WRITES_PER_MINUTE);

/** What one sweep did, per account. */
export interface SubscriptionSweepResult {
  account: string;
  /** Top-level folders discovered in My Drive. */
  folders: number;
  /** Subscriptions created for the first time. */
  created: number;
  /** Subscriptions renewed before expiry. */
  renewed: number;
  /** Subscriptions already healthy and far from expiry. */
  skipped: number;
  /**
   * Subscriptions Google already had that we had no record of, looked up by
   * target resource and adopted into the table so they can be renewed.
   */
  adopted: number;
  /** Rows dropped because the folder no longer exists. */
  pruned: number;
  /** Per-folder failures (folder id → message), capped for legibility. */
  errors: { folderId: string; error: string }[];
}

/** Injectable seams so the sweep is testable without Google or D1. */
export interface SubscriptionSweepDeps {
  listFolders(account: string, ref: string): Promise<{ id: string; name: string }[]>;
  create(ref: string, folderId: string): Promise<{ name?: string; state?: string; expireTime?: string }>;
  /** Find the subscription Google already holds for a folder, if any. */
  findByFolder(
    ref: string,
    folderId: string,
  ): Promise<{ name?: string; state?: string; expireTime?: string } | null>;
  renew(ref: string, subscriptionName: string): Promise<{ state?: string; expireTime?: string }>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

/** Real Google-backed dependencies. */
function liveDeps(env: Env): SubscriptionSweepDeps {
  return {
    listFolders: async (_account, ref) => new DriveService(env, ref).listChildFolders("root"),
    create: async (ref, folderId) =>
      new WorkspaceEventsService(env, ref).createSubscription(
        `//drive.googleapis.com/files/${folderId}`,
        [...WATCHED_EVENT_TYPES],
        DEFAULT_PUBSUB_TOPIC,
        // includeResource MUST stay false — true drops the max TTL to 4 hours.
        { includeResource: false, includeDescendants: true },
      ),
    findByFolder: async (ref, folderId) => {
      const { subscriptions } = await new WorkspaceEventsService(env, ref).listSubscriptions(
        `target_resource="//drive.googleapis.com/files/${folderId}"`,
      );
      return subscriptions[0] ?? null;
    },
    renew: async (ref, name) => new WorkspaceEventsService(env, ref).renewSubscription(name),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** True when Google says the subscription already exists for this target. */
function isAlreadyExists(message: string): boolean {
  return /ALREADY_EXISTS|already exists/i.test(message);
}

/**
 * Create-or-renew a standing subscription for every top-level Drive folder on
 * every active account.
 *
 * Safe to run repeatedly: a subscription comfortably far from expiry is
 * skipped, so the hourly cron costs one cheap folder listing per account on
 * most runs.
 *
 * @param env - Worker env
 * @param deps - Injected seams (tests pass fakes)
 * @returns One {@link SubscriptionSweepResult} per account
 * @example
 * const results = await syncWorkspaceSubscriptions(env);
 */
export async function syncWorkspaceSubscriptions(
  env: Env,
  deps: SubscriptionSweepDeps = liveDeps(env),
): Promise<SubscriptionSweepResult[]> {
  const db = getDb(env);
  const accounts = (await listCaptureAccounts(env)).filter(
    (a) => !a.email.endsWith(".iam.gserviceaccount.com"),
  );
  const out: SubscriptionSweepResult[] = [];

  for (const { email, ref } of accounts) {
    const result: SubscriptionSweepResult = {
      account: email,
      folders: 0,
      created: 0,
      renewed: 0,
      skipped: 0,
      adopted: 0,
      pruned: 0,
      errors: [],
    };

    let folders: { id: string; name: string }[];
    try {
      folders = await deps.listFolders(email, ref);
    } catch (e) {
      // A dead token for one account must not stop the other's sweep.
      result.errors.push({ folderId: "(listing)", error: describe(e) });
      out.push(result);
      continue;
    }
    result.folders = folders.length;

    const existing = await db
      .select()
      .from(workspaceSubscriptions)
      .where(eq(workspaceSubscriptions.account, email));
    const byFolder = new Map(existing.map((r) => [r.folderId, r]));

    // Drop rows for folders that are gone; Google has already dropped the
    // subscription, and a stale row would inflate the health count.
    const liveIds = new Set(folders.map((f) => f.id));
    for (const row of existing) {
      if (liveIds.has(row.folderId)) continue;
      await db.delete(workspaceSubscriptions).where(eq(workspaceSubscriptions.id, row.id));
      result.pruned++;
    }

    const now = deps.now();
    let writes = 0;

    for (const folder of folders) {
      const row = byFolder.get(folder.id);
      const expiresAt = row?.expireAt?.getTime();
      const healthy =
        row?.subscriptionName &&
        row.state === "ACTIVE" &&
        expiresAt !== undefined &&
        expiresAt - now.getTime() > RENEW_BEFORE_MS;

      if (healthy) {
        result.skipped++;
        continue;
      }

      // Pace only between actual writes — a run that skips everything is free.
      if (writes > 0) await deps.sleep(WRITE_SPACING_MS);
      writes++;

      try {
        let sub: { name?: string; state?: string; expireTime?: string };
        if (row?.subscriptionName) {
          sub = await deps.renew(ref, row.subscriptionName);
          sub.name ??= row.subscriptionName;
          result.renewed++;
        } else {
          sub = await deps.create(ref, folder.id);
          result.created++;
        }
        await upsertRow(db, email, folder, sub, now);
      } catch (e) {
        const message = describe(e);
        // ALREADY_EXISTS means Google has a subscription we lost track of.
        // Record the folder so the next sweep renews rather than re-creating,
        // and do not count it as a failure the operator must act on.
        if (isAlreadyExists(message)) {
          // Google already holds a subscription for this folder that we have no
          // row for — typically one created by hand before this table existed.
          // Adopting it is not cosmetic: without its resource name we could
          // never renew it, so it would expire in 7 days and stay dead while
          // the sweep kept "succeeding" against ALREADY_EXISTS forever.
          try {
            const found = await deps.findByFolder(ref, folder.id);
            if (found) {
              await upsertRow(db, email, folder, found, now);
              result.adopted++;
              continue;
            }
            result.errors.push({
              folderId: folder.id,
              error: "ALREADY_EXISTS but no subscription found for this target",
            });
          } catch (lookupError) {
            result.errors.push({ folderId: folder.id, error: describe(lookupError).slice(0, 300) });
          }
        } else {
          result.errors.push({ folderId: folder.id, error: message.slice(0, 300) });
        }
        await noteFailure(db, email, folder, message, now);
      }
    }

    out.push(result);
  }

  return out;
}

/** Normalize a thrown value to a message. */
function describe(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
}

/** Insert or update the bookkeeping row after a successful create/renew. */
async function upsertRow(
  db: ReturnType<typeof getDb>,
  account: string,
  folder: { id: string; name: string },
  sub: { name?: string; state?: string; expireTime?: string },
  now: Date,
): Promise<void> {
  const values = {
    id: `${account}:${folder.id}`,
    account,
    folderId: folder.id,
    folderName: folder.name,
    subscriptionName: sub.name ?? null,
    state: sub.state ?? "ACTIVE",
    expireAt: sub.expireTime ? new Date(sub.expireTime) : null,
    lastError: null,
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .insert(workspaceSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: workspaceSubscriptions.id,
      set: {
        folderName: values.folderName,
        subscriptionName: values.subscriptionName,
        state: values.state,
        expireAt: values.expireAt,
        lastError: null,
        lastSyncedAt: now,
        updatedAt: now,
      },
    });
}

/** Record a failure against the folder without losing an existing row. */
async function noteFailure(
  db: ReturnType<typeof getDb>,
  account: string,
  folder: { id: string; name: string },
  error: string,
  now: Date,
): Promise<void> {
  await db
    .insert(workspaceSubscriptions)
    .values({
      id: `${account}:${folder.id}`,
      account,
      folderId: folder.id,
      folderName: folder.name,
      lastError: error.slice(0, 500),
      updatedAt: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceSubscriptions.id,
      set: { folderName: folder.name, lastError: error.slice(0, 500), updatedAt: now },
    });
}

/**
 * Count the subscriptions that are actually live right now, for the health
 * probe. A row that exists but has expired is NOT live — counting it would be
 * the whole bug this module exists to fix, one level up.
 *
 * @param env - Worker env
 * @returns Per-account live/total counts and the soonest expiry
 */
export async function countLiveSubscriptions(
  env: Env,
  now: Date = new Date(),
): Promise<{ account: string; live: number; total: number; nextExpiry: string | null }[]> {
  const db = getDb(env);
  const rows = await db.select().from(workspaceSubscriptions);
  const accounts = await db.select().from(googleAccounts);
  const emails = new Set(accounts.filter((a) => a.status !== "revoked").map((a) => a.email));
  for (const r of rows) emails.add(r.account);

  return [...emails].map((account) => {
    const mine = rows.filter((r) => r.account === account);
    const live = mine.filter(
      (r) => r.state === "ACTIVE" && r.expireAt !== null && r.expireAt.getTime() > now.getTime(),
    );
    const next = live
      .map((r) => r.expireAt as Date)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return {
      account,
      live: live.length,
      total: mine.length,
      nextExpiry: next ? next.toISOString() : null,
    };
  });
}

/** Re-exported so callers do not need to reach into `e2e.ts` for the topic. */
export { DEFAULT_PUBSUB_TOPIC };
