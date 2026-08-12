import { describe, it, expect, vi } from "vitest";

import { runSweep, MAX_ATTEMPTS, type SweepDeps, type DueRow } from "../scheduled-email";

/**
 * In-memory model of the queue. `claim` mirrors the production conditional
 * UPDATE ... WHERE status=expected: it yields once (to force interleaving under
 * Promise.all) and then does a SYNCHRONOUS check-and-set — the same atomicity the
 * single SQL statement provides. This is what stops a double-send.
 */
function makeStore(rows: Record<number, { status: string; sendAt: number; attempts: number }>, sendSpy: (id: number) => void) {
  const spec = { to: "a@b.com", subject: "s" };
  const deps: SweepDeps = {
    async listDue(now) {
      const out: DueRow[] = [];
      for (const [id, r] of Object.entries(rows)) {
        if ((r.status === "scheduled" || r.status === "error") && r.sendAt <= now && r.attempts < MAX_ATTEMPTS) {
          out.push({ id: Number(id), status: r.status, accountRef: "ref", spec });
        }
      }
      return out;
    },
    async claim(id, expected) {
      await Promise.resolve(); // yield so a concurrent pass also gets past listDue
      const r = rows[id];
      if (r && r.status === expected) {
        r.status = "sending"; // synchronous check-and-set → atomic
        return true;
      }
      return false;
    },
    async send(row) {
      sendSpy(row.id);
      return `msg_${row.id}`;
    },
    async markSent(id) {
      rows[id].status = "sent";
    },
    async markError(id, _e) {
      rows[id].status = "error";
      rows[id].attempts += 1;
    },
  };
  return deps;
}

describe("runSweep", () => {
  it("does NOT send a future email (send_at not yet reached)", async () => {
    const now = Date.parse("2026-08-12T12:00:00Z");
    const future = Date.parse("2026-08-13T09:00:00Z");
    const rows = { 1: { status: "scheduled", sendAt: future, attempts: 0 } };
    const send = vi.fn();
    const res = await runSweep(makeStore(rows, send), now);
    expect(res.due).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(rows[1].status).toBe("scheduled");
  });

  it("sends a due email exactly ONCE under two concurrent sweep passes (atomic claim)", async () => {
    const now = Date.parse("2026-08-12T12:00:00Z");
    const rows = { 1: { status: "scheduled", sendAt: now - 1000, attempts: 0 } };
    const send = vi.fn();
    const deps = makeStore(rows, send);
    // Two overlapping ticks racing for the same row.
    await Promise.all([runSweep(deps, now), runSweep(deps, now)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows[1].status).toBe("sent");
  });

  it("a canceled row is never sent", async () => {
    const now = Date.parse("2026-08-12T12:00:00Z");
    const rows = { 1: { status: "canceled", sendAt: now - 1000, attempts: 0 } };
    const send = vi.fn();
    const res = await runSweep(makeStore(rows, send), now);
    expect(res.due).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("a send failure marks the row error (retryable, not dropped)", async () => {
    const now = Date.parse("2026-08-12T12:00:00Z");
    const rows = { 1: { status: "scheduled", sendAt: now - 1000, attempts: 0 } };
    const deps = makeStore(rows, () => {
      throw new Error("smtp boom");
    });
    await runSweep(deps, now);
    expect(rows[1].status).toBe("error");
    expect(rows[1].attempts).toBe(1);
  });
});
