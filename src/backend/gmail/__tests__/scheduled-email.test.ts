import { describe, it, expect, vi } from "vitest";

import { runSweep, MAX_ATTEMPTS, STALE_SENDING_MS, type SweepDeps, type DueRow } from "../scheduled-email";

type Row = { status: string; sendAt: number; attempts: number; claimedAt: number | null };

/**
 * In-memory model of the queue. `claim` mirrors the production conditional UPDATE
 * ... WHERE status=? AND claimedAt=? : it yields once (to force interleaving under
 * Promise.all) then does a SYNCHRONOUS check-and-set guarded on BOTH the status
 * and the claimedAt we read — the same optimistic-lock atomicity the single SQL
 * statement provides. This is what stops a double-send / double-reclaim.
 */
function makeStore(rows: Record<number, Row>, sendSpy: (id: number) => void, throwOnSend = false) {
  const spec = { to: "a@b.com", subject: "s" };
  const deps: SweepDeps = {
    async listDue(now) {
      const out: DueRow[] = [];
      for (const [id, r] of Object.entries(rows)) {
        const fresh = (r.status === "scheduled" || r.status === "error") && r.sendAt <= now && r.attempts < MAX_ATTEMPTS;
        const crashed = r.status === "sending" && r.claimedAt != null && r.claimedAt <= now - STALE_SENDING_MS;
        if (fresh || crashed) out.push({ id: Number(id), status: r.status, claimedAt: r.claimedAt, accountRef: "ref", spec });
      }
      return out;
    },
    async claim(row, whenMs) {
      await Promise.resolve(); // yield so a concurrent pass also gets past listDue
      const r = rows[row.id];
      if (r && r.status === row.status && (r.claimedAt ?? null) === (row.claimedAt ?? null)) {
        r.status = "sending"; // synchronous check-and-set → atomic
        r.claimedAt = whenMs;
        return true;
      }
      return false;
    },
    async send(row) {
      if (throwOnSend) throw new Error("smtp boom");
      sendSpy(row.id);
      return `msg_${row.id}`;
    },
    async markSent(id) {
      rows[id].status = "sent";
    },
    async markError(id) {
      rows[id].status = "error";
      rows[id].attempts += 1;
    },
  };
  return deps;
}

const NOW = Date.parse("2026-08-12T12:00:00Z");

describe("runSweep", () => {
  it("does NOT send a future email (send_at not yet reached)", async () => {
    const rows = { 1: { status: "scheduled", sendAt: Date.parse("2026-08-13T09:00:00Z"), attempts: 0, claimedAt: null } };
    const send = vi.fn();
    const res = await runSweep(makeStore(rows, send), NOW);
    expect(res.due).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(rows[1].status).toBe("scheduled");
  });

  it("sends a due email exactly ONCE under two concurrent sweep passes (atomic claim)", async () => {
    const rows = { 1: { status: "scheduled", sendAt: NOW - 1000, attempts: 0, claimedAt: null } };
    const send = vi.fn();
    const deps = makeStore(rows, send);
    await Promise.all([runSweep(deps, NOW), runSweep(deps, NOW)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows[1].status).toBe("sent");
  });

  it("a canceled row is never sent", async () => {
    const rows = { 1: { status: "canceled", sendAt: NOW - 1000, attempts: 0, claimedAt: null } };
    const send = vi.fn();
    const res = await runSweep(makeStore(rows, send), NOW);
    expect(res.due).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("a send failure marks the row error (retryable, not dropped)", async () => {
    const rows = { 1: { status: "scheduled", sendAt: NOW - 1000, attempts: 0, claimedAt: null } };
    await runSweep(makeStore(rows, vi.fn(), true), NOW);
    expect(rows[1].status).toBe("error");
    expect(rows[1].attempts).toBe(1);
  });

  it("does NOT reclaim a row that is still actively sending (within the stale window)", async () => {
    const rows = { 1: { status: "sending", sendAt: NOW - 5000, attempts: 1, claimedAt: NOW - 60_000 } };
    const send = vi.fn();
    const res = await runSweep(makeStore(rows, send), NOW);
    expect(res.due).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("reclaims and re-sends a row stuck in 'sending' past the stale window (crash recovery)", async () => {
    const rows = { 1: { status: "sending", sendAt: NOW - 5000, attempts: 1, claimedAt: NOW - (STALE_SENDING_MS + 1000) } };
    const send = vi.fn();
    const res = await runSweep(makeStore(rows, send), NOW);
    expect(res.due).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows[1].status).toBe("sent");
  });

  it("reclaims a stale 'sending' row exactly once under two concurrent passes", async () => {
    const rows = { 1: { status: "sending", sendAt: NOW - 5000, attempts: 1, claimedAt: NOW - (STALE_SENDING_MS + 1000) } };
    const send = vi.fn();
    const deps = makeStore(rows, send);
    await Promise.all([runSweep(deps, NOW), runSweep(deps, NOW)]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
