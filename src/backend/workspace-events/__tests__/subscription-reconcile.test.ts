/**
 * @fileoverview Guards for the reconcile pass and the evidence-split coverage
 * report.
 *
 * These exist because of a measured failure on 2026-09-28: the table claimed
 * 252 live subscriptions for `justin@126colby.com` while a per-folder lookup
 * found 8 of 20 sampled and Google's own listing returned 100. Every create had
 * reported success with a real expiry. A count of our own writes is not a count
 * of coverage, and every assertion below is the inverse of believing otherwise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  countLiveSubscriptions,
  reconcileWorkspaceSubscriptions,
  resetAbandonedSubscriptions,
  type ReconcileDeps,
} from "../subscription-manager";

type Row = Record<string, unknown>;
const rows: Record<string, Row> = {};
const updates: { id: string; set: Row }[] = [];

vi.mock("@/backend/gmail/sync-service", () => ({
  listCaptureAccounts: vi.fn(async () => [{ email: "justin@126colby.com", ref: "ref-j" }]),
}));
vi.mock("@db/schemas", () => ({
  workspaceSubscriptions: { account: "account", id: "id" },
  googleAccounts: { email: "email", status: "status" },
}));
vi.mock("@/backend/db", () => ({
  getDb: () => ({
    // `from` must distinguish the two tables: returning subscription rows for
    // the accounts query seeds the account list with `undefined`, which is what
    // made the first version of these tests read zero for everything.
    select: () => ({
      from: async (table: { email?: string }) =>
        table?.email === "email" ? [] : Object.values(rows),
    }),
    update: () => ({
      set: (set: Row) => ({
        where: async () => {
          // The fake where() cannot filter, so the caller's id is recovered from
          // the single-row fixtures these tests use.
          const id = (set.__id as string) ?? Object.keys(rows)[updates.length] ?? "unknown";
          updates.push({ id, set });
          if (rows[id]) Object.assign(rows[id], set);
        },
      }),
    }),
  }),
}));

const NOW = new Date("2026-09-30T12:00:00.000Z");

function deps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    findByFolder: vi.fn(async () => null),
    now: () => NOW,
    sleep: vi.fn(async () => undefined),
    ...over,
  };
}

/** One row as the sweep would have written it: looks live, never verified. */
function unverifiedRow(id: string, over: Row = {}): Row {
  return {
    id,
    account: "justin@126colby.com",
    folderId: id.split(":")[1] ?? id,
    subscriptionName: `subscriptions/${id}`,
    state: "ACTIVE",
    expireAt: new Date("2026-10-07T00:00:00.000Z"),
    verifiedAt: null,
    missingStreak: 0,
    ...over,
  };
}

beforeEach(() => {
  for (const k of Object.keys(rows)) delete rows[k];
  updates.length = 0;
});

describe("reconcileWorkspaceSubscriptions", () => {
  it("stamps verifiedAt only when Google actually confirms the subscription", async () => {
    rows["justin@126colby.com:f1"] = unverifiedRow("justin@126colby.com:f1");
    const d = deps({
      findByFolder: vi.fn(async () => ({
        name: "subscriptions/real",
        state: "ACTIVE",
        expireTime: "2026-10-07T00:00:00.000Z",
      })),
    });
    const [r] = await reconcileWorkspaceSubscriptions({} as Env, d);
    expect(r.confirmed).toBe(1);
    expect(r.missing).toBe(0);
    expect(updates[0].set.verifiedAt).toEqual(NOW);
    expect(updates[0].set.missingStreak).toBe(0);
  });

  it("clears a row Google does not have so the next sweep recreates it", async () => {
    rows["justin@126colby.com:f1"] = unverifiedRow("justin@126colby.com:f1");
    const [r] = await reconcileWorkspaceSubscriptions({} as Env, deps());
    expect(r.missing).toBe(1);
    expect(r.abandoned).toBe(0);
    // Nulling these is what puts the folder back on the create path.
    expect(updates[0].set.subscriptionName).toBeNull();
    expect(updates[0].set.expireAt).toBeNull();
    expect(updates[0].set.missingStreak).toBe(1);
  });

  it("abandons a row after repeated disappearances instead of looping forever", async () => {
    // missingStreak 2 + this run = 3 = MAX_MISSING_RETRIES.
    rows["justin@126colby.com:f1"] = unverifiedRow("justin@126colby.com:f1", { missingStreak: 2 });
    const [r] = await reconcileWorkspaceSubscriptions({} as Env, deps());
    expect(r.abandoned).toBe(1);
    expect(updates[0].set.state).toBe("ABANDONED");
    // It must NOT be cleared for recreation — that is the loop this prevents.
    expect(updates[0].set.subscriptionName).not.toBeNull();
  });

  it("leaves the previous verdict alone when the lookup itself fails", async () => {
    // A failed lookup proves nothing. Recording it as missing would be
    // concluding from an absence we never established.
    rows["justin@126colby.com:f1"] = unverifiedRow("justin@126colby.com:f1");
    const d = deps({
      findByFolder: vi.fn(async () => {
        throw new Error("Google API 429: Too many requests");
      }),
    });
    const [r] = await reconcileWorkspaceSubscriptions({} as Env, d);
    expect(r.errors).toBe(1);
    expect(r.missing).toBe(0);
    expect(updates).toHaveLength(0);
  });
});

describe("countLiveSubscriptions", () => {
  it("does not count an unconfirmed row as coverage", async () => {
    // This is the exact defect: the row looks live by our own bookkeeping and
    // Google has never been asked. It must not land in `verified`.
    rows["justin@126colby.com:f1"] = unverifiedRow("justin@126colby.com:f1");
    const [c] = await countLiveSubscriptions({} as Env, NOW);
    expect(c.verified).toBe(0);
    expect(c.unverified).toBe(1);
    expect(c.total).toBe(1);
  });

  it("counts a freshly confirmed row as verified", async () => {
    rows["justin@126colby.com:f1"] = unverifiedRow("justin@126colby.com:f1", {
      verifiedAt: new Date(NOW.getTime() - 60_000),
    });
    const [c] = await countLiveSubscriptions({} as Env, NOW);
    expect(c.verified).toBe(1);
    expect(c.unverified).toBe(0);
    expect(c.nextExpiry).toBe("2026-10-07T00:00:00.000Z");
  });

  it("treats a stale confirmation as unproven, not as coverage", async () => {
    rows["justin@126colby.com:f1"] = unverifiedRow("justin@126colby.com:f1", {
      verifiedAt: new Date(NOW.getTime() - 7 * 60 * 60 * 1000), // older than 6h
    });
    const [c] = await countLiveSubscriptions({} as Env, NOW);
    expect(c.verified).toBe(0);
    expect(c.unverified).toBe(1);
  });

  it("reports abandoned rows separately so the real problem has a size", async () => {
    rows["justin@126colby.com:f1"] = unverifiedRow("justin@126colby.com:f1", {
      state: "ABANDONED",
      missingStreak: 3,
      verifiedAt: NOW,
    });
    const [c] = await countLiveSubscriptions({} as Env, NOW);
    expect(c.abandoned).toBe(1);
    expect(c.verified).toBe(0);
  });
});

describe("resetAbandonedSubscriptions", () => {
  it("clears an ABANDONED row so the sweep will try it again", async () => {
    rows["justin@126colby.com:f1"] = unverifiedRow("justin@126colby.com:f1", {
      state: "ABANDONED",
      missingStreak: 3,
      verifiedAt: NOW,
    });
    const out = await resetAbandonedSubscriptions({} as Env);
    expect(out).toEqual([{ account: "justin@126colby.com", reset: 1 }]);
    // Nulling the identity is what puts it back on the create path; zeroing the
    // streak is what gives it a full set of attempts rather than instant re-abandon.
    expect(updates[0].set.state).toBeNull();
    expect(updates[0].set.subscriptionName).toBeNull();
    expect(updates[0].set.missingStreak).toBe(0);
  });

  it("leaves a healthy row untouched", async () => {
    rows["justin@126colby.com:f1"] = unverifiedRow("justin@126colby.com:f1", { verifiedAt: NOW });
    const out = await resetAbandonedSubscriptions({} as Env);
    expect(out).toEqual([]);
    expect(updates).toHaveLength(0);
  });

  it("scopes the reset to one account when asked", async () => {
    rows["justin@126colby.com:f1"] = unverifiedRow("justin@126colby.com:f1", {
      state: "ABANDONED",
      missingStreak: 3,
    });
    rows["other@example.test:f2"] = {
      ...unverifiedRow("other@example.test:f2", { state: "ABANDONED", missingStreak: 3 }),
      account: "other@example.test",
    };
    const out = await resetAbandonedSubscriptions({} as Env, "justin@126colby.com");
    expect(out).toEqual([{ account: "justin@126colby.com", reset: 1 }]);
  });
});
