/**
 * @file src/backend/db/schemas/workspace-subscriptions.ts
 * @description Drizzle schema for `workspace_subscriptions` — the standing
 * Workspace Events subscriptions this worker maintains over real Drive folders.
 *
 * Why a table at all: a Workspace Events subscription is NOT durable
 * infrastructure. Measured 2026-09-28, three constraints force bookkeeping:
 *
 *  1. **Max TTL is 7 days** (and only 4 hours if the payload carries resource
 *     data), so every subscription must be renewed on a schedule or the event
 *     pipeline silently goes dark. It already did: between 2026-09-03 and
 *     2026-09-28 the only rows that arrived were the expiry notices of a
 *     subscription nobody renewed.
 *  2. **One subscription per target resource per user** — a second create on
 *     the same folder returns ALREADY_EXISTS, so the sweep has to be
 *     create-or-renew and needs to remember what it already made.
 *  3. **My Drive root cannot be subscribed** (`400 Use the full name of the
 *     resource` / `403 Permission denied`), so coverage is one subscription per
 *     top-level folder with `includeDescendants`, discovered and re-discovered
 *     as folders come and go.
 */

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/** One standing Workspace Events subscription over a Drive folder. */
export const workspaceSubscriptions = sqliteTable(
  "workspace_subscriptions",
  {
    /** Synthetic id (`<account>:<folderId>`), so the row is addressable before Google names it. */
    id: text("id").primaryKey(),
    /** Google account that owns the subscription. */
    account: text("account").notNull(),
    /** Drive folder id being watched. */
    folderId: text("folder_id").notNull(),
    /** Folder name at last discovery — for display only; ids are authoritative. */
    folderName: text("folder_name"),
    /** Google's subscription resource name (`subscriptions/…`), null until created. */
    subscriptionName: text("subscription_name"),
    /** Google's reported state: ACTIVE | SUSPENDED | DELETED, or null before the first create. */
    state: text("state"),
    /** When Google expires this subscription; the sweep renews before it. */
    expireAt: integer("expire_at", { mode: "timestamp" }),
    /** Last failure message, cleared on the next success. */
    lastError: text("last_error"),
    /** When the sweep last successfully created or renewed this subscription. */
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
    /**
     * When Google last CONFIRMED this subscription exists, by a lookup against
     * its own API rather than by us writing a row.
     *
     * This column exists because the first version of this table was trusted as
     * if it were Google's state. Measured 2026-09-28: it claimed 252 live
     * subscriptions for `justin@126colby.com` while a per-folder lookup found
     * only 8 of 20 sampled, and Google's own listing returned 100. Every create
     * had returned success with a real `expireTime`; Google accepted them and
     * did not keep them. A count of our own writes is not a count of coverage.
     */
    verifiedAt: integer("verified_at", { mode: "timestamp" }),
    /**
     * Consecutive times a lookup has come back with no subscription for this
     * folder despite a create having reported success.
     *
     * Needed as a stop: recreating on every sweep would loop forever against
     * whatever is dropping them (a per-user cap, a delivery-authorization
     * reaper), churning writes and reporting activity while coverage never
     * improves. Past MAX_MISSING_RETRIES the row is left alone and surfaced.
     */
    missingStreak: integer("missing_streak").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex("workspace_subs_account_folder").on(t.account, t.folderId)],
);

/** Zod schema for selecting rows from `workspace_subscriptions`. */
export const selectWorkspaceSubscriptionSchema = createSelectSchema(workspaceSubscriptions);
/** Zod schema for inserting rows into `workspace_subscriptions`. */
export const insertWorkspaceSubscriptionSchema = createInsertSchema(workspaceSubscriptions);
