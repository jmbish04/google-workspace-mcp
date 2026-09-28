/**
 * @fileoverview Guards for the standing-subscription sweep.
 *
 * Every assertion is the inverse of something that was true in production on
 * 2026-09-28 (no standing subscriptions, nothing renewed, expired rows would
 * have read as coverage), so each fails if the behaviour regresses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  syncWorkspaceSubscriptions,
  WATCHED_EVENT_TYPES,
  type SubscriptionSweepDeps,
} from "../subscription-manager";

const rows: Record<string, Record<string, unknown>> = {};
const deleted: string[] = [];

vi.mock("@/backend/gmail/sync-service", () => ({
  listCaptureAccounts: vi.fn(async () => [{ email: "jmbish04@gmail.com", ref: "ref-1" }]),
}));

vi.mock("@db/schemas", () => ({
  workspaceSubscriptions: { account: "account", id: "id" },
  googleAccounts: { email: "email", status: "status" },
}));

// A hand-rolled stand-in for the Drizzle chain: enough shape to record what the
// sweep writes, without pulling D1 into a unit test.
vi.mock("@/backend/db", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: async () => Object.values(rows) }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
          const id = v.id as string;
          rows[id] = rows[id] ? { ...rows[id], ...set } : v;
        },
      }),
    }),
    delete: () => ({ where: async () => deleted.push("one") }),
  }),
}));

function deps(over: Partial<SubscriptionSweepDeps> = {}): SubscriptionSweepDeps {
  return {
    listFolders: vi.fn(async () => [{ id: "folder-a", name: "_NEST" }]),
    create: vi.fn(async () => ({
      name: "subscriptions/sub-a",
      state: "ACTIVE",
      expireTime: "2026-10-05T00:00:00.000Z",
    })),
    findByFolder: vi.fn(async () => null),
    renew: vi.fn(async () => ({ state: "ACTIVE", expireTime: "2026-10-12T00:00:00.000Z" })),
    now: () => new Date("2026-09-28T00:00:00.000Z"),
    sleep: vi.fn(async () => undefined),
    ...over,
  };
}

describe("syncWorkspaceSubscriptions", () => {
  beforeEach(() => {
    for (const k of Object.keys(rows)) delete rows[k];
    deleted.length = 0;
  });

  it("creates a resource-free, descendant-including subscription for a new folder", async () => {
    const d = deps();
    const [r] = await syncWorkspaceSubscriptions({} as Env, d);
    expect(r.created).toBe(1);
    expect(r.renewed).toBe(0);
    expect(d.create).toHaveBeenCalledWith("ref-1", "folder-a");
    expect(rows["jmbish04@gmail.com:folder-a"]).toMatchObject({
      subscriptionName: "subscriptions/sub-a",
      state: "ACTIVE",
    });
  });

  it("renews rather than re-creating when a subscription is near expiry", async () => {
    // ALREADY_EXISTS is what a re-create would earn here, so renewing is not a
    // style preference — re-creating is simply broken.
    rows["jmbish04@gmail.com:folder-a"] = {
      id: "jmbish04@gmail.com:folder-a",
      account: "jmbish04@gmail.com",
      folderId: "folder-a",
      subscriptionName: "subscriptions/sub-a",
      state: "ACTIVE",
      expireAt: new Date("2026-09-28T06:00:00.000Z"), // 6h away, inside the 48h window
    };
    const d = deps();
    const [r] = await syncWorkspaceSubscriptions({} as Env, d);
    expect(r.renewed).toBe(1);
    expect(r.created).toBe(0);
    expect(d.renew).toHaveBeenCalledWith("ref-1", "subscriptions/sub-a");
    expect(d.create).not.toHaveBeenCalled();
  });

  it("skips a subscription that is comfortably far from expiring", async () => {
    rows["jmbish04@gmail.com:folder-a"] = {
      id: "jmbish04@gmail.com:folder-a",
      account: "jmbish04@gmail.com",
      folderId: "folder-a",
      subscriptionName: "subscriptions/sub-a",
      state: "ACTIVE",
      expireAt: new Date("2026-10-05T00:00:00.000Z"), // 7 days out
    };
    const d = deps();
    const [r] = await syncWorkspaceSubscriptions({} as Env, d);
    expect(r.skipped).toBe(1);
    expect(d.create).not.toHaveBeenCalled();
    expect(d.renew).not.toHaveBeenCalled();
  });

  it("adopts the subscription Google already holds on ALREADY_EXISTS", async () => {
    // Without adopting we never learn its resource name, so it could never be
    // renewed — it would expire in 7 days while the sweep kept "succeeding".
    const d = deps({
      create: vi.fn(async () => {
        throw new Error("Google API 409: ALREADY_EXISTS");
      }),
      findByFolder: vi.fn(async () => ({
        name: "subscriptions/pre-existing",
        state: "ACTIVE",
        expireTime: "2026-10-05T00:00:00.000Z",
      })),
    });
    const [r] = await syncWorkspaceSubscriptions({} as Env, d);
    expect(r.errors).toHaveLength(0);
    expect(r.adopted).toBe(1);
    expect(rows["jmbish04@gmail.com:folder-a"]).toMatchObject({
      subscriptionName: "subscriptions/pre-existing",
    });
  });

  it("reports ALREADY_EXISTS as an error when the subscription cannot be found", async () => {
    // Silently counting this as covered is how an unrenewable subscription
    // hides: it would read as success forever and expire anyway.
    const d = deps({
      create: vi.fn(async () => {
        throw new Error("Google API 409: ALREADY_EXISTS");
      }),
      findByFolder: vi.fn(async () => null),
    });
    const [r] = await syncWorkspaceSubscriptions({} as Env, d);
    expect(r.adopted).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].error).toMatch(/no subscription found/);
  });

  it("records a real failure instead of swallowing it", async () => {
    const d = deps({
      create: vi.fn(async () => {
        throw new Error("Google API 403: Permission denied");
      }),
    });
    const [r] = await syncWorkspaceSubscriptions({} as Env, d);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].error).toMatch(/Permission denied/);
  });

  it("prunes bookkeeping for folders that no longer exist", async () => {
    rows["jmbish04@gmail.com:gone"] = {
      id: "jmbish04@gmail.com:gone",
      account: "jmbish04@gmail.com",
      folderId: "gone",
      subscriptionName: "subscriptions/old",
      state: "ACTIVE",
      expireAt: new Date("2026-10-05T00:00:00.000Z"),
    };
    const [r] = await syncWorkspaceSubscriptions({} as Env, deps());
    expect(r.pruned).toBe(1);
  });

  it("keeps the event set resource-free so the 7-day TTL is available", () => {
    // includeResource:true would cap the TTL at 4 hours; these are the types
    // the sweep asks for and they must not imply resource payloads.
    expect([...WATCHED_EVENT_TYPES]).toEqual([
      "google.workspace.drive.file.v3.created",
      "google.workspace.drive.file.v3.contentChanged",
      "google.workspace.drive.file.v3.deleted",
      "google.workspace.drive.comment.v3.created",
    ]);
  });
});
