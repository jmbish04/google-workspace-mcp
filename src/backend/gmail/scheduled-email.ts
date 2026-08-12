/**
 * @file gmail/scheduled-email.ts
 * @description The scheduled-email queue: enqueue a full send spec + `send_at`,
 * and a sweep that sends due rows through the SAME path as gmail_send. Each due
 * row is claimed ATOMICALLY (scheduled/error → sending) so two overlapping ticks
 * can't double-send; failures land in `error` (retryable while under the attempt
 * cap), never dropped.
 *
 * The sweep logic is split from its IO so it's unit-testable: {@link runSweep}
 * takes injectable deps; {@link sweepScheduledEmails} wires them to D1 + Gmail.
 *
 * ponytail: if the worker is hard-killed between the claim and markSent/markError
 * (e.g. isolate eviction mid-send), a row can be left in 'sending' and won't be
 * re-swept (listDue only claims scheduled/error) — it stays VISIBLE in
 * list_scheduled_emails (never silently dropped), but isn't auto-retried. Safe
 * auto-recovery needs a `claimedAt` timestamp so a stale 'sending' row can be
 * reclaimed atomically without racing a genuinely in-flight send. Add that column
 * if crash-recovery matters; the double-send guarantee does not depend on it.
 */
import { and, eq, inArray, lt, lte } from "drizzle-orm";

import { getDb } from "@/backend/db";
import { scheduledEmails, type ScheduledEmailSpec } from "@db/schemas";
import { GmailService } from "@/backend/mcp/services/gmail";

/** Give up (leave visible) after this many failed attempts. */
export const MAX_ATTEMPTS = 5;
/** Statuses a due row can be claimed from. */
export const CLAIMABLE_STATUSES = ["scheduled", "error"] as const;

export interface DueRow {
  id: number;
  status: string;
  accountRef: string;
  spec: ScheduledEmailSpec;
}

/** IO the sweep depends on — real (D1/Gmail) in prod, in-memory in tests. */
export interface SweepDeps {
  /** Rows whose send_at has passed and are still claimable. */
  listDue(now: number): Promise<DueRow[]>;
  /**
   * Atomically claim a row: flip `expectedStatus` → 'sending' and return true
   * IFF this caller won. MUST be a single conditional write (no read-then-write
   * gap) so concurrent ticks can't both win.
   */
  claim(id: number, expectedStatus: string): Promise<boolean>;
  /** Perform the real send; returns the Gmail message id. */
  send(row: DueRow): Promise<string>;
  markSent(id: number, messageId: string): Promise<void>;
  markError(id: number, error: string): Promise<void>;
}

/**
 * Run one sweep pass. Claims each due row atomically before sending, so if two
 * passes run concurrently only one sends a given row.
 */
export async function runSweep(deps: SweepDeps, now: number): Promise<{ due: number; sent: number }> {
  const due = await deps.listDue(now);
  let sent = 0;
  for (const row of due) {
    if (!(await deps.claim(row.id, row.status))) continue; // lost the race — another tick has it
    try {
      const messageId = await deps.send(row);
      await deps.markSent(row.id, messageId);
      sent += 1;
    } catch (e) {
      await deps.markError(row.id, e instanceof Error ? e.message : String(e));
    }
  }
  return { due: due.length, sent };
}

/** Production sweep: D1-backed deps + real Gmail send. */
export async function sweepScheduledEmails(env: Env, now: number = Date.now()): Promise<{ due: number; sent: number }> {
  const db = getDb(env);
  const nowDate = new Date(now);

  const deps: SweepDeps = {
    async listDue() {
      const rows = await db
        .select()
        .from(scheduledEmails)
        .where(
          and(
            inArray(scheduledEmails.status, CLAIMABLE_STATUSES as unknown as string[]),
            lte(scheduledEmails.sendAt, nowDate),
            lt(scheduledEmails.attempts, MAX_ATTEMPTS),
          ),
        );
      return rows.map((r) => ({ id: r.id, status: r.status, accountRef: r.accountRef, spec: r.spec }));
    },
    async claim(id, expectedStatus) {
      // Single conditional UPDATE ... WHERE status=expected RETURNING — atomic in
      // SQLite/D1, so only one concurrent tick flips scheduled/error → sending.
      const claimed = await db
        .update(scheduledEmails)
        .set({ status: "sending" })
        .where(and(eq(scheduledEmails.id, id), eq(scheduledEmails.status, expectedStatus)))
        .returning({ id: scheduledEmails.id });
      return claimed.length === 1;
    },
    async send(row) {
      const s = row.spec;
      const res = await new GmailService(env, row.accountRef).send(s.to, s.subject, s.body ?? "", {
        html: s.html,
        markdown: s.markdown,
        attachments: s.attachments as never,
        driveIds: s.driveIds,
        blobs: s.blobs,
      });
      return res.id;
    },
    async markSent(id, messageId) {
      await db
        .update(scheduledEmails)
        .set({ status: "sent", messageId, sentAt: new Date(), error: null })
        .where(eq(scheduledEmails.id, id));
    },
    async markError(id, error) {
      // Back to 'error' (not 'sending') so it stays visible and retryable while
      // under the attempt cap; bump attempts here.
      const [row] = await db.select({ attempts: scheduledEmails.attempts }).from(scheduledEmails).where(eq(scheduledEmails.id, id));
      await db
        .update(scheduledEmails)
        .set({ status: "error", error, attempts: (row?.attempts ?? 0) + 1 })
        .where(eq(scheduledEmails.id, id));
    },
  };

  return runSweep(deps, now);
}
