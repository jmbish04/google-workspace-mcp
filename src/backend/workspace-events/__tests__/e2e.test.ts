import { describe, expect, it, vi } from "vitest";
import { aggregateE2eHealth, resolveE2eAccount, runWorkspaceEventsE2eWithDeps, type WorkspaceEventsE2eDeps } from "../e2e";

vi.mock("@/backend/gmail/sync-service", () => ({
  listCaptureAccounts: vi.fn(),
}));

import { listCaptureAccounts } from "@/backend/gmail/sync-service";

const listAccounts = vi.mocked(listCaptureAccounts);

function deps(overrides: Partial<WorkspaceEventsE2eDeps> = {}): WorkspaceEventsE2eDeps {
  return {
    accountEmail: "tester@example.com",
    createDoc: vi.fn(async () => ({ documentId: "doc-1" })),
    renameFile: vi.fn(async () => undefined),
    commentOnFile: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    listNotificationsFor: vi.fn(async () => [
      {
        resourceId: "doc-1",
        resourceState: "google.workspace.drive.file.v3.contentChanged",
        payload: { type: "google.workspace.drive.file.v3.contentChanged", subject: "files/doc-1" },
      },
    ]),
    persist: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    now: () => new Date("2026-09-01T15:00:00.000Z"),
    randomUUID: () => "run-1",
    ...overrides,
  };
}

describe("aggregateE2eHealth", () => {
  it("is unhealthy when a mutation fails", () => {
    expect(
      aggregateE2eHealth([
        { action: "create", status: "fail", durationMs: 1, error: "boom" },
      ]),
    ).toBe("unhealthy");
  });

  it("is unhealthy when monitor sees zero events", () => {
    expect(
      aggregateE2eHealth([
        { action: "create", status: "ok", durationMs: 1 },
        { action: "monitor", status: "fail", durationMs: 1, count: 0 },
      ]),
    ).toBe("unhealthy");
  });

  it("is degraded when events arrive but no known family matches", () => {
    expect(
      aggregateE2eHealth([
        { action: "create", status: "ok", durationMs: 1 },
        { action: "monitor", status: "ok", durationMs: 1, count: 1, families: ["other"] },
      ]),
    ).toBe("degraded");
  });

  it("is healthy when mutations succeed and a known family is observed", () => {
    expect(
      aggregateE2eHealth([
        { action: "create", status: "ok", durationMs: 1 },
        { action: "monitor", status: "ok", durationMs: 1, count: 2, families: ["change"] },
      ]),
    ).toBe("healthy");
  });
});

describe("runWorkspaceEventsE2eWithDeps", () => {
  it("runs create → rename → comment → delete → monitor and persists", async () => {
    const d = deps();
    const run = await runWorkspaceEventsE2eWithDeps(d, { settleMs: 0, pollAttempts: 1, pollIntervalMs: 0 });
    expect(d.createDoc).toHaveBeenCalledOnce();
    expect(d.renameFile).toHaveBeenCalledWith("doc-1", expect.stringContaining("Renamed"));
    expect(d.commentOnFile).toHaveBeenCalledWith("doc-1", expect.stringContaining("E2E health check comment"));
    expect(d.deleteFile).toHaveBeenCalledWith("doc-1");
    expect(d.listNotificationsFor).toHaveBeenCalledWith(["doc-1"]);
    expect(run.status).toBe("ok");
    expect(run.health).toBe("healthy");
    expect(run.docId).toBe("doc-1");
    expect(run.results.map((r) => r.action)).toEqual(["create", "rename", "comment", "delete", "monitor"]);
    expect(run.results.every((r) => r.status === "ok")).toBe(true);
    expect(d.persist).toHaveBeenCalledWith(run);
  });

  it("subscribes to the file after create when no folder helper is provided", async () => {
    const subscribeToFile = vi.fn(async () => ({ name: "subscriptions/file-1" }));
    const unsubscribe = vi.fn(async () => undefined);
    const d = deps({ subscribeToFile, unsubscribe });
    const run = await runWorkspaceEventsE2eWithDeps(d, { settleMs: 0, pollAttempts: 1, pollIntervalMs: 0 });
    expect(subscribeToFile).toHaveBeenCalledWith("doc-1");
    expect(run.results.map((r) => r.action)).toEqual([
      "create",
      "subscribe",
      "rename",
      "comment",
      "delete",
      "monitor",
    ]);
    expect(unsubscribe).toHaveBeenCalledWith("subscriptions/file-1");
  });

  it("creates a folder, subscribes with descendants, then creates the doc inside it", async () => {
    const createFolder = vi.fn(async () => ({ id: "folder-1" }));
    const createDoc = vi.fn(async (_title: string, parentId?: string) => {
      expect(parentId).toBe("folder-1");
      return { documentId: "doc-1" };
    });
    const subscribeToFile = vi.fn(async () => ({ name: "subscriptions/folder-1" }));
    const unsubscribe = vi.fn(async () => undefined);
    const d = deps({ createFolder, createDoc, subscribeToFile, unsubscribe });
    const run = await runWorkspaceEventsE2eWithDeps(d, { settleMs: 0, pollAttempts: 1, pollIntervalMs: 0 });
    expect(createFolder).toHaveBeenCalledOnce();
    expect(subscribeToFile).toHaveBeenCalledWith("folder-1", { includeDescendants: true });
    expect(createDoc).toHaveBeenCalledWith(expect.stringContaining("Test Doc"), "folder-1");
    expect(run.results.map((r) => r.action)).toEqual([
      "folder",
      "subscribe",
      "create",
      "rename",
      "comment",
      "delete",
      "monitor",
    ]);
    expect(unsubscribe).toHaveBeenCalledWith("subscriptions/folder-1");
    expect(d.deleteFile).toHaveBeenCalledWith("folder-1");
    expect(d.listNotificationsFor).toHaveBeenCalledWith(["doc-1", "folder-1"]);
  });

  it("still unsubscribes when monitor finds no events", async () => {
    const unsubscribe = vi.fn(async () => undefined);
    const d = deps({
      subscribeToFile: vi.fn(async () => ({ name: "subscriptions/x" })),
      unsubscribe,
      listNotificationsFor: vi.fn(async () => []),
    });
    await runWorkspaceEventsE2eWithDeps(d, { settleMs: 0, pollAttempts: 1, pollIntervalMs: 0 });
    expect(unsubscribe).toHaveBeenCalledWith("subscriptions/x");
  });

  it("stops after create failure and does not mutate further", async () => {
    const d = deps({
      createDoc: vi.fn(async () => {
        throw new Error("docs down");
      }),
    });
    const run = await runWorkspaceEventsE2eWithDeps(d, { settleMs: 0, pollAttempts: 1, pollIntervalMs: 0 });
    expect(d.renameFile).not.toHaveBeenCalled();
    expect(d.deleteFile).not.toHaveBeenCalled();
    expect(run.status).toBe("fail");
    expect(run.health).toBe("unhealthy");
    expect(run.results).toHaveLength(1);
    expect(run.results[0].error).toContain("docs down");
  });

  it("fails monitor when no webhook rows appear", async () => {
    const d = deps({
      listNotificationsFor: vi.fn(async () => []),
    });
    const run = await runWorkspaceEventsE2eWithDeps(d, { settleMs: 0, pollAttempts: 2, pollIntervalMs: 0 });
    const monitor = run.results.find((r) => r.action === "monitor");
    expect(monitor?.status).toBe("fail");
    expect(monitor?.count).toBe(0);
    expect(run.health).toBe("unhealthy");
  });
});

describe("resolveE2eAccount", () => {
  it("skips service-account emails and uses the first human account", async () => {
    listAccounts.mockResolvedValue([
      { email: "bot@discovery-383518.iam.gserviceaccount.com", ref: "bot@discovery-383518.iam.gserviceaccount.com" },
      { email: "justin@126colby.com", ref: "sub-justin" },
    ]);
    await expect(resolveE2eAccount({} as Env)).resolves.toEqual({
      email: "justin@126colby.com",
      ref: "sub-justin",
    });
  });

  it("throws when no accounts are signed in", async () => {
    listAccounts.mockResolvedValue([]);
    await expect(resolveE2eAccount({} as Env)).rejects.toThrow(/No signed-in Google account/);
  });
});
