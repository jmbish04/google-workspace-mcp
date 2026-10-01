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

/**
 * Google allows 100 subscription READS per minute per user, so a reconcile pass
 * verifies at most this many rows per account per run, oldest-verified first.
 * A full pass over ~253 folders therefore completes across a few hourly runs
 * rather than blowing the read budget (or the request) in one go.
 */
const VERIFY_PER_RUN = 80;

/** A verification older than this is stale — treated as unproven, not as coverage. */
const VERIFY_FRESH_MS = 6 * 60 * 60 * 1000;

/**
 * State for a subscription Google asserts exists (`409 ALREADY_EXISTS`) but
 * whose resource name we cannot obtain, because `subscriptions.list` caps at
 * 100 rows per user with no `nextPageToken`.
 *
 * It is LIVE — proven 2026-10-01: `Paperless Inbox` returned nothing from a
 * `target_resource` lookup, `create` returned ALREADY_EXISTS, and a document
 * written into it delivered three CloudEvents within seconds. What it is not is
 * renewable: with no resource name there is nothing to PATCH, so it expires at
 * its 7-day TTL and the next sweep's create succeeds and makes a fresh one.
 * Coverage therefore self-heals weekly rather than breaking.
 */
const STATE_UNRENEWABLE = "ACTIVE_UNRENEWABLE";

/**
 * State for a row whose subscription we hold a name for but could not confirm.
 *
 * NOT the same as absent. A lookup miss above the listing's 100-row ceiling is
 * a fact about the listing, not about Google — treating it as absence is what
 * previously marked 153 working subscriptions as abandoned.
 */
const STATE_UNCONFIRMABLE = "UNCONFIRMABLE";
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
  /** Folders the reconcile pass gave up on; not retried by this sweep. */
  abandoned: number;
  /**
   * Folders Google confirmed via ALREADY_EXISTS but whose resource name the
   * listing would not surface. Live, but not renewable — see
   * {@link STATE_UNRENEWABLE}.
   */
  unrenewable: number;
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
      unrenewable: 0,
      skipped: 0,
      adopted: 0,
      pruned: 0,
      abandoned: 0,
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

      // Given up on by the reconcile pass: recreating would restart a loop
      // against whatever keeps dropping it. Leave it, and let the coverage
      // report carry it as abandoned rather than as churn.
      if (row?.state === "ABANDONED") {
        result.abandoned++;
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
          // `409 ALREADY_EXISTS` is Google telling us the subscription IS there.
          // It is the most reliable evidence available — more so than a lookup,
          // which cannot see past the listing's 100-row ceiling. Treating it as
          // a failure is what produced 109 phantom errors and 153 phantom
          // abandonments over subscriptions that were delivering events.
          //
          // Try to recover the resource name so the row stays renewable; if the
          // listing cannot show it, record it as live-but-unrenewable rather
          // than pretending either that it is missing or that we can renew it.
          let found: { name?: string; state?: string; expireTime?: string } | null = null;
          try {
            found = await deps.findByFolder(ref, folder.id);
          } catch {
            // Lookup failure changes nothing: ALREADY_EXISTS already proved it.
          }
          if (found) {
            await upsertRow(db, email, folder, found, now);
            result.adopted++;
          } else {
            await markUnrenewable(db, email, folder, now);
            result.unrenewable++;
          }
          continue;
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

/** Per-account coverage, split by how well each row is actually evidenced. */
export interface SubscriptionCoverage {
  account: string;
  /**
   * Rows Google CONFIRMED recently, unexpired. The only number that means
   * coverage — every other bucket is a row we cannot vouch for.
   */
  verified: number;
  /**
   * Rows that look live by our own bookkeeping but have not been confirmed
   * within the freshness window. Reported separately rather than added to
   * `verified`, because counting our own writes as coverage is precisely the
   * defect this split exists to prevent.
   */
  unverified: number;
  /**
   * Rows Google confirmed exist via ALREADY_EXISTS but whose resource name the
   * listing would not surface. LIVE and delivering events — just not renewable,
   * so each expires at its 7-day TTL and the next sweep recreates it.
   */
  assumedLive: number;
  /** Rows the listing could not show and the sweep has not yet settled. */
  unconfirmable: number;
  /** Rows given up on after repeated disappearances — the real problem, named. */
  abandoned: number;
  /** Rows in the table for this account. */
  total: number;
  /** Soonest expiry among verified rows. */
  nextExpiry: string | null;
}

/**
 * Report per-account coverage, split by evidence.
 *
 * Deliberately does NOT return one "live" number. The previous version did, by
 * counting rows we had written, and reported 252 for an account Google was
 * holding about 100 subscriptions for. A single number invites exactly that
 * mistake, so callers are handed the split and have to decide what counts.
 *
 * @param env - Worker env
 * @param now - Clock injection for tests
 * @returns One {@link SubscriptionCoverage} per account
 * @example
 * const cov = await countLiveSubscriptions(env);
 * const trustworthy = cov.every((c) => c.unverified === 0 && c.abandoned === 0);
 */
export async function countLiveSubscriptions(
  env: Env,
  now: Date = new Date(),
): Promise<SubscriptionCoverage[]> {
  const db = getDb(env);
  const rows = await db.select().from(workspaceSubscriptions);
  const accounts = await db.select().from(googleAccounts);
  const emails = new Set(accounts.filter((a) => a.status !== "revoked").map((a) => a.email));
  for (const r of rows) emails.add(r.account);

  return [...emails].map((account) => {
    const mine = rows.filter((r) => r.account === account);
    const looksLive = (r: (typeof mine)[number]) =>
      r.state === "ACTIVE" && r.expireAt !== null && r.expireAt.getTime() > now.getTime();
    const freshlyVerified = (r: (typeof mine)[number]) =>
      r.verifiedAt !== null && now.getTime() - r.verifiedAt.getTime() < VERIFY_FRESH_MS;

    const abandoned = mine.filter((r) => r.state === "ABANDONED");
    // ALREADY_EXISTS is confirmation, so these count as coverage — they are
    // simply unrenewable. Excluding them is what made 153 live subscriptions
    // read as a failure.
    const assumedLive = mine.filter(
      (r) => r.state === STATE_UNRENEWABLE && freshlyVerified(r),
    );
    const unconfirmable = mine.filter((r) => r.state === STATE_UNCONFIRMABLE);
    const verified = mine.filter((r) => looksLive(r) && freshlyVerified(r));
    const unverified = mine.filter((r) => looksLive(r) && !freshlyVerified(r));

    const next = verified
      .map((r) => r.expireAt as Date)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    return {
      account,
      verified: verified.length,
      assumedLive: assumedLive.length,
      unverified: unverified.length,
      unconfirmable: unconfirmable.length,
      abandoned: abandoned.length,
      total: mine.length,
      nextExpiry: next ? next.toISOString() : null,
    };
  });
}

/** Re-exported so callers do not need to reach into `e2e.ts` for the topic. */
export { DEFAULT_PUBSUB_TOPIC };

/**
 * Clear the ABANDONED verdict so the next sweep tries these folders again.
 *
 * Needed because abandonment is deliberately sticky: once Google has dropped a
 * folder's subscription three times the sweep stops recreating it, which is what
 * keeps it from churning writes forever against the 100-per-user cap. But the
 * cap is not permanent — nesting folders under a shared parent frees slots,
 * since a subscription with `includeDescendants` covers a whole subtree for one
 * slot. When capacity appears, nothing would ever retry without this.
 *
 * Deliberately NOT automatic: a sweep that un-abandons on its own would restore
 * the infinite retry loop that abandonment exists to stop. Someone has to know
 * that capacity actually changed.
 *
 * @param env - Worker env
 * @param account - Limit to one account, or omit for all
 * @returns How many rows were reset, per account
 * @example
 * await resetAbandonedSubscriptions(env, "justin@126colby.com");
 */
export async function resetAbandonedSubscriptions(
  env: Env,
  account?: string,
): Promise<{ account: string; reset: number }[]> {
  const db = getDb(env);
  const rows = (await db.select().from(workspaceSubscriptions)).filter(
    (r) => r.state === "ABANDONED" && (!account || r.account === account),
  );
  const now = new Date();

  for (const row of rows) {
    await db
      .update(workspaceSubscriptions)
      .set({
        // Null the subscription identity so the sweep takes the create path,
        // and zero the streak so it gets a full set of attempts again.
        subscriptionName: null,
        expireAt: null,
        state: null,
        missingStreak: 0,
        verifiedAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(workspaceSubscriptions.id, row.id));
  }

  const byAccount = new Map<string, number>();
  for (const row of rows) byAccount.set(row.account, (byAccount.get(row.account) ?? 0) + 1);
  return [...byAccount].map(([acct, reset]) => ({ account: acct, reset }));
}

// ---------------------------------------------------------------------------
// Reconciliation — ask Google what it actually holds
// ---------------------------------------------------------------------------

/** What one reconcile pass found, per account. */
export interface ReconcileResult {
  account: string;
  /** Rows examined this run (bounded by {@link VERIFY_PER_RUN}). */
  checked: number;
  /** Rows Google confirmed. */
  confirmed: number;
  /**
   * Rows the listing could not show. NOT absent — the listing caps at 100 rows
   * per user, so this is a limit of the instrument. The sweep's `create` settles
   * each one: ALREADY_EXISTS means live, a clean create means it was genuinely
   * gone and now is not.
   */
  unconfirmable: number;
  /**
   * Rows that have gone missing {@link MAX_MISSING_RETRIES} times in a row.
   * These will NOT be recreated again — something upstream is dropping them,
   * and this count is the honest size of that problem.
   */
  abandoned: number;
  /** Lookup failures (network, quota); the row keeps its previous verdict. */
  errors: number;
}

/** Seam for the reconcile pass so tests need neither Google nor D1. */
export interface ReconcileDeps {
  findByFolder(
    ref: string,
    folderId: string,
  ): Promise<{ name?: string; state?: string; expireTime?: string } | null>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

/** Real Google-backed reconcile dependencies. */
function liveReconcileDeps(env: Env): ReconcileDeps {
  return {
    findByFolder: async (ref, folderId) => {
      const { subscriptions } = await new WorkspaceEventsService(env, ref).listSubscriptions(
        `target_resource="//drive.googleapis.com/files/${folderId}"`,
      );
      return subscriptions[0] ?? null;
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * Ask Google, per folder, whether the subscription we recorded actually exists,
 * and write the answer to `verifiedAt` / `missingStreak`.
 *
 * This is the only thing that makes a coverage number trustworthy. Without it
 * the table records what we asked for; with it the table records what Google
 * confirms. Those differed by a factor of three the first time anyone checked.
 *
 * A row Google does not have is cleared (`subscriptionName`/`expireAt` nulled)
 * so the next sweep recreates it — but only until `missingStreak` reaches
 * {@link MAX_MISSING_RETRIES}, after which it is left alone and counted as
 * abandoned rather than retried forever.
 *
 * @param env - Worker env
 * @param deps - Injected seams (tests pass fakes)
 * @returns One {@link ReconcileResult} per account
 * @example
 * const results = await reconcileWorkspaceSubscriptions(env);
 */
export async function reconcileWorkspaceSubscriptions(
  env: Env,
  deps: ReconcileDeps = liveReconcileDeps(env),
): Promise<ReconcileResult[]> {
  const db = getDb(env);
  const accounts = (await listCaptureAccounts(env)).filter(
    (a) => !a.email.endsWith(".iam.gserviceaccount.com"),
  );
  const allRows = await db.select().from(workspaceSubscriptions);
  const out: ReconcileResult[] = [];
  const now = deps.now();

  for (const { email, ref } of accounts) {
    const result: ReconcileResult = {
      account: email,
      checked: 0,
      confirmed: 0,
      unconfirmable: 0,
      abandoned: 0,
      errors: 0,
    };

    // Oldest verification first, so a bounded run still sweeps everything over
    // a few cycles instead of re-checking the same head of the list.
    const mine = allRows
      .filter((r) => r.account === email)
      .sort((a, b) => (a.verifiedAt?.getTime() ?? 0) - (b.verifiedAt?.getTime() ?? 0))
      .slice(0, VERIFY_PER_RUN);

    for (const row of mine) {
      if (result.checked > 0) await deps.sleep(WRITE_SPACING_MS);
      result.checked++;

      let found: { name?: string; state?: string; expireTime?: string } | null;
      try {
        found = await deps.findByFolder(ref, row.folderId);
      } catch {
        // A failed lookup proves nothing either way — leave the row's previous
        // verdict alone rather than recording an absence we did not establish.
        result.errors++;
        continue;
      }

      if (found) {
        await db
          .update(workspaceSubscriptions)
          .set({
            subscriptionName: found.name ?? row.subscriptionName,
            state: found.state ?? "ACTIVE",
            expireAt: found.expireTime ? new Date(found.expireTime) : row.expireAt,
            verifiedAt: now,
            missingStreak: 0,
            lastError: null,
            updatedAt: now,
          })
          .where(eq(workspaceSubscriptions.id, row.id));
        result.confirmed++;
        continue;
      }

      // A lookup that found nothing is NOT evidence of absence. `subscriptions.list`
      // caps at 100 rows per user with no cursor, so above that ceiling a live
      // subscription is simply invisible — proven 2026-10-01, when a folder the
      // lookup denied delivered three CloudEvents seconds after a write.
      //
      // So: keep the identity, mark the row unconfirmable, and let the sweep's
      // `create` settle it. ALREADY_EXISTS there means live; a clean create means
      // it really was gone and now is not. Concluding "missing" here is what
      // abandoned 153 working subscriptions.
      await db
        .update(workspaceSubscriptions)
        .set({
          state: STATE_UNCONFIRMABLE,
          missingStreak: row.missingStreak + 1,
          verifiedAt: null,
          lastError:
            "Not visible in subscriptions.list (capped at 100 rows); the sweep's create will settle it.",
          updatedAt: now,
        })
        .where(eq(workspaceSubscriptions.id, row.id));
      result.unconfirmable++;
    }

    out.push(result);
  }

  return out;
}

/**
 * Record a folder as live-but-unrenewable: Google answered ALREADY_EXISTS, so
 * the subscription demonstrably exists, but the listing would not yield its
 * resource name so there is nothing to renew.
 *
 * `verifiedAt` IS stamped, because ALREADY_EXISTS is confirmation — it is
 * stronger evidence than the lookup that cannot see past 100 rows.
 *
 * @param db - Drizzle handle
 * @param account - Account email
 * @param folder - The watched folder
 * @param now - Clock
 */
async function markUnrenewable(
  db: ReturnType<typeof getDb>,
  account: string,
  folder: { id: string; name: string },
  now: Date,
): Promise<void> {
  const values = {
    id: `${account}:${folder.id}`,
    account,
    folderId: folder.id,
    folderName: folder.name,
    subscriptionName: null,
    state: STATE_UNRENEWABLE,
    expireAt: null,
    lastError: null,
    missingStreak: 0,
    verifiedAt: now,
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
        state: STATE_UNRENEWABLE,
        verifiedAt: now,
        missingStreak: 0,
        lastError: null,
        lastSyncedAt: now,
        updatedAt: now,
      },
    });
}
