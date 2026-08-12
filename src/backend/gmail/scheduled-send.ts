/**
 * @file gmail/scheduled-send.ts
 * @description Hourly sweep for the scheduled_sends queue: for each unsent row
 * whose cron has come due since it was last checked, send the pinned draft and
 * mark it sent. Idempotent-ish — `sent` is the guard; the hourly cadence is far
 * longer than a send, so overlap is unlikely.
 *
 * ponytail: no per-row lock — a slow send overlapping the next hourly tick could
 * double-send. Add a "sending" claim column if that ever bites.
 */
import { eq } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { scheduledSends } from "@db/schemas";
import { GmailService } from "@/backend/mcp/services/gmail";
import { cronDueSince } from "./cron";

/** Send every scheduled draft that has come due. Returns counts for logging. */
export async function sweepScheduledSends(env: Env, now: number = Date.now()): Promise<{ checked: number; sent: number }> {
  const db = getDb(env);
  const pending = await db.select().from(scheduledSends).where(eq(scheduledSends.sent, false));
  let sent = 0;

  for (const row of pending) {
    const createdMs = row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt) * 1000;
    const since = row.lastCheckedAt ?? createdMs;

    if (!cronDueSince(row.cron, since, now)) {
      await db.update(scheduledSends).set({ lastCheckedAt: now }).where(eq(scheduledSends.id, row.id));
      continue;
    }

    try {
      const res = await new GmailService(env, row.accountRef).sendDraft(row.draftId);
      await db
        .update(scheduledSends)
        .set({ sent: true, sentMessageId: res.id, sentAt: new Date(), lastCheckedAt: now, error: null })
        .where(eq(scheduledSends.id, row.id));
      sent += 1;
    } catch (e) {
      await db
        .update(scheduledSends)
        .set({ lastCheckedAt: now, error: e instanceof Error ? e.message : String(e) })
        .where(eq(scheduledSends.id, row.id));
    }
  }

  return { checked: pending.length, sent };
}
