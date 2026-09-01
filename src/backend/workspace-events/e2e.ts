/**
 * @fileoverview End-to-end Workspace Events pipeline probe.
 *
 * Workspace Events subscriptions are per file or folder (not "all of My Drive"),
 * so the probe creates a folder, subscribes to it with `includeDescendants`,
 * then creates / renames / comments / permanently deletes a Doc inside that
 * folder. It polls `drive_notifications` until Pub/Sub → webhook → D1 has
 * recorded at least one event for that file (or the poll budget expires).
 * Each run is persisted to `health_runs` + `health_results` with
 * `metadata.kind = "workspace_events_e2e"` so the frontend, MCP tools, and
 * the local mjs harness can all read the same history.
 *
 * Intended to run inside a Worker invocation (HTTP, MCP, or the CLI hitting
 * POST /api/gws-health-check/run-e2e). Wall-clock wait is I/O, not CPU, so
 * the ~40s poll stays within Workers paid-plan limits.
 *
 * @example
 * ```typescript
 * const run = await runWorkspaceEventsE2e(env, { trigger: "manual" });
 * ```
 */
import { desc, inArray, sql } from "drizzle-orm";

import { listCaptureAccounts } from "@/backend/gmail/sync-service";
import { CommentsService } from "@/backend/mcp/services/comments";
import { DocsService } from "@/backend/mcp/services/docs";
import { DriveService } from "@/backend/mcp/services/drive";
import { WorkspaceEventsService } from "@/backend/mcp/services/workspaceevents";
import { getDb } from "@/db";
import { driveNotifications, healthResults, healthRuns } from "@db/schemas";

import { classifyEventFamily, extractEventType, type WorkspaceEventFamily } from "./parse";

/** KV/D1 marker stored on every E2E health_runs row so list queries can filter. */
export const WORKSPACE_EVENTS_E2E_KIND = "workspace_events_e2e";

/** One mutation or monitor step in an E2E run. */
export type WorkspaceEventsE2eStep = {
  action: "folder" | "create" | "subscribe" | "rename" | "comment" | "delete" | "monitor";
  status: "ok" | "fail";
  durationMs: number;
  docId?: string;
  subscriptionName?: string;
  count?: number;
  events?: Array<Record<string, unknown>>;
  eventTypes?: string[];
  families?: WorkspaceEventFamily[];
  error?: string;
};

/** Serialized E2E run returned to HTTP, MCP, and the frontend. */
export type WorkspaceEventsE2eRun = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "fail";
  health: "healthy" | "degraded" | "unhealthy" | "unknown";
  docId: string | null;
  folderId?: string | null;
  subscriptionName?: string;
  account?: string;
  tag?: string;
  results: WorkspaceEventsE2eStep[];
};

export type WorkspaceEventsE2eTrigger = "manual" | "scheduled" | "agent";

export type RunWorkspaceEventsE2eOptions = {
  trigger?: WorkspaceEventsE2eTrigger;
  /** Optional signed-in account email (`as_user`). Defaults to the first active OAuth account. */
  account?: string;
  /** Sleep between Drive mutations so distinct events can fire. Default 1000ms. */
  settleMs?: number;
  /** Max poll loops waiting for webhook rows. Default 20 (~40s at 2s). */
  pollAttempts?: number;
  /** Delay between poll loops. Default 2000ms. */
  pollIntervalMs?: number;
};

const DEFAULT_SETTLE_MS = 1000;
const DEFAULT_POLL_ATTEMPTS = 20;
const DEFAULT_POLL_INTERVAL_MS = 2000;

/** Pub/Sub topic Workspace Events publishes into (push → this Worker).
 *  Must live in the OAuth app's GCP project (`discovery-383518`); the API
 *  rejects topics in a different project even when IAM looks correct. */
export const DEFAULT_PUBSUB_TOPIC =
  "projects/discovery-383518/topics/workspace-events-topic";

/** CloudEvent types covering rename / comment / delete on a single Drive file. */
export const E2E_EVENT_TYPES = [
  "google.workspace.drive.file.v3.created",
  "google.workspace.drive.file.v3.renamed",
  "google.workspace.drive.comment.v3.created",
  "google.workspace.drive.file.v3.deleted",
  "google.workspace.drive.file.v3.contentChanged",
];

/**
 * Pick a signed-in OAuth account for the E2E probe. Prefers human Google
 * accounts over service-account emails, then the first active registry row.
 *
 * @param env - Worker bindings
 * @param asUser - Optional email to act as
 * @returns Display email plus the token `ref` `getAccessToken` expects
 * @throws When no signed-in account exists or `asUser` is unknown
 */
export async function resolveE2eAccount(
  env: Env,
  asUser?: string,
): Promise<{ email: string; ref: string }> {
  const accounts = await listCaptureAccounts(env);
  const usable = accounts.filter((a) => !a.email.endsWith(".iam.gserviceaccount.com"));
  if (asUser) {
    const needle = asUser.trim().toLowerCase();
    const match = usable.find((a) => a.email === needle) ?? accounts.find((a) => a.email === needle);
    if (!match) {
      throw new Error(
        `Unknown as_user "${asUser}" — not a signed-in account. Sign in at /api/auth/google/oauth/start?label=${encodeURIComponent(asUser)}.`,
      );
    }
    return match;
  }
  const first = usable[0] ?? accounts[0];
  if (!first) {
    throw new Error("No signed-in Google account. Sign in at /api/auth/google/oauth/start.");
  }
  return first;
}

/**
 * Injectable collaborators so unit tests can run the pipeline without Google or D1.
 */
export type WorkspaceEventsE2eDeps = {
  accountEmail: string;
  createDoc: (title: string, parentId?: string) => Promise<{ documentId: string }>;
  renameFile: (id: string, name: string) => Promise<void>;
  commentOnFile: (id: string, content: string) => Promise<void>;
  deleteFile: (id: string) => Promise<void>;
  listNotificationsFor: (resourceIds: string[]) => Promise<Array<Record<string, unknown>>>;
  /** Create a folder so we can subscribe before the test Doc exists (captures `created`). */
  createFolder?: (name: string) => Promise<{ id: string }>;
  subscribeToFile?: (
    resourceId: string,
    opts?: { includeDescendants?: boolean },
  ) => Promise<{ name: string }>;
  unsubscribe?: (name: string) => Promise<void>;
  persist?: (run: WorkspaceEventsE2eRun) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  randomUUID?: () => string;
};

/**
 * Aggregate per-step outcomes into the D1 health_runs status enum.
 *
 * @param results - Completed E2E steps
 * @returns healthy when mutations + at least one event succeeded; degraded when
 *   events arrived but no mutation-family match; unhealthy otherwise
 */
export function aggregateE2eHealth(
  results: WorkspaceEventsE2eStep[],
): WorkspaceEventsE2eRun["health"] {
  if (results.length === 0) return "unknown";
  const mutations = results.filter((r) => r.action !== "monitor");
  const monitor = results.find((r) => r.action === "monitor");
  if (mutations.some((r) => r.status === "fail")) return "unhealthy";
  if (!monitor || monitor.status === "fail" || (monitor.count ?? 0) < 1) return "unhealthy";
  const families = new Set(monitor.families ?? []);
  const informative = ["create", "change", "comment", "delete"].filter((f) => families.has(f as WorkspaceEventFamily));
  if (informative.length === 0) return "degraded";
  return "healthy";
}

/**
 * Run the folder → subscribe → create → rename → comment → delete → monitor pipeline.
 *
 * @param env - Worker bindings (D1, Secrets Store, Google auth)
 * @param options - Trigger label and poll budget
 * @returns Persisted run summary
 * @throws Never — step failures are recorded on the run
 *
 * @example
 * ```typescript
 * const run = await runWorkspaceEventsE2e(env, { trigger: "agent" });
 * ```
 */
export async function runWorkspaceEventsE2e(
  env: Env,
  options: RunWorkspaceEventsE2eOptions = {},
): Promise<WorkspaceEventsE2eRun> {
  try {
    const { email, ref } = await resolveE2eAccount(env, options.account);
    const docs = new DocsService(env, ref);
    const drive = new DriveService(env, ref);
    const comments = new CommentsService(env, ref);
    const eventsApi = new WorkspaceEventsService(env, ref);
    const db = getDb(env);

    return await runWorkspaceEventsE2eWithDeps({
      accountEmail: email,
      createFolder: async (name) => {
        const folder = await drive.createFolder(name);
        return { id: folder.id };
      },
      createDoc: async (title, parentId) => {
        if (parentId) {
          const file = await drive.createDocFromMarkdown(title, `# ${title}\n`, parentId);
          return { documentId: file.id };
        }
        return docs.create(title);
      },
      subscribeToFile: async (resourceId, opts) => {
        const sub = await eventsApi.createSubscription(
          `//drive.googleapis.com/files/${resourceId}`,
          E2E_EVENT_TYPES,
          DEFAULT_PUBSUB_TOPIC,
          { includeDescendants: opts?.includeDescendants, ttl: "3600s" },
        );
        if (!sub.name) {
          throw new Error("Workspace Events createSubscription returned no resource name");
        }
        return { name: sub.name };
      },
      unsubscribe: async (name) => {
        await eventsApi.deleteSubscription(name);
      },
      renameFile: async (id, name) => {
        await drive.updateFile(id, { name });
      },
      commentOnFile: async (id, content) => {
        await comments.create(id, content);
      },
      deleteFile: (id) => drive.deleteFile(id),
      listNotificationsFor: async (resourceIds) => {
        const ids = resourceIds.filter(Boolean);
        if (ids.length === 0) return [];
        const rows = await db
          .select()
          .from(driveNotifications)
          .where(inArray(driveNotifications.resourceId, ids))
          .orderBy(desc(driveNotifications.receivedAt));
        return rows as Array<Record<string, unknown>>;
      },
      persist: (run) => persistE2eRun(env, run, options.trigger ?? "manual"),
    }, options);
  } catch (err) {
    const run: WorkspaceEventsE2eRun = {
      runId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "fail",
      health: "unhealthy",
      docId: null,
      results: [
        {
          action: "create",
          status: "fail",
          durationMs: 0,
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    };
    await persistE2eRun(env, run, options.trigger ?? "manual").catch(() => undefined);
    return run;
  }
}

/**
 * Same pipeline as {@link runWorkspaceEventsE2e} with injected I/O (for tests).
 *
 * @param deps - Google + D1 collaborators
 * @param options - Poll budget
 * @returns Run summary (also passed to `deps.persist` when provided)
 */
export async function runWorkspaceEventsE2eWithDeps(
  deps: WorkspaceEventsE2eDeps,
  options: RunWorkspaceEventsE2eOptions = {},
): Promise<WorkspaceEventsE2eRun> {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());

  const runId = randomUUID();
  const startedAt = now().toISOString();
  const tag = `e2e-test-${Date.now()}`;
  const results: WorkspaceEventsE2eStep[] = [];
  let docId: string | null = null;
  let folderId: string | undefined;
  let subscriptionName: string | undefined;
  let subscribed = false;

  const step = async (
    action: WorkspaceEventsE2eStep["action"],
    fn: () => Promise<Partial<WorkspaceEventsE2eStep>>,
  ) => {
    const t0 = Date.now();
    try {
      const extra = await fn();
      const status = extra.status ?? "ok";
      results.push({ action, status, durationMs: Date.now() - t0, ...extra });
      return status === "ok";
    } catch (err) {
      results.push({
        action,
        status: "fail",
        durationMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  try {
    if (deps.createFolder) {
      await step("folder", async () => {
        const folder = await deps.createFolder!(`E2E Events ${tag}`);
        folderId = folder.id;
        return { docId: folder.id };
      });
    }

    if (folderId && deps.subscribeToFile) {
      await sleep(settleMs);
      subscribed = await step("subscribe", async () => {
        const created = await deps.subscribeToFile!(folderId!, { includeDescendants: true });
        subscriptionName = created.name;
        return { subscriptionName };
      });
      if (subscribed) await sleep(settleMs);
    }

    await step("create", async () => {
      const created = await deps.createDoc(`Test Doc ${tag}`, folderId);
      docId = created.documentId;
      return { docId };
    });

    if (docId && deps.subscribeToFile && !subscribed) {
      await sleep(settleMs);
      subscribed = await step("subscribe", async () => {
        const created = await deps.subscribeToFile!(docId!);
        subscriptionName = created.name;
        return { subscriptionName };
      });
      if (subscribed) await sleep(settleMs);
    }

    if (docId) {
      await sleep(settleMs);
      await step("rename", async () => {
        await deps.renameFile(docId!, `Test Doc Renamed ${tag}`);
        return {};
      });

      await sleep(settleMs);
      await step("comment", async () => {
        await deps.commentOnFile(docId!, `E2E health check comment — ${tag}`);
        return {};
      });

      // Comment CloudEvents are published against the live file; deleting
      // immediately after comments.create drops them.
      await sleep(Math.max(settleMs * 2, 3000));
      await step("delete", async () => {
        await deps.deleteFile(docId!);
        return {};
      });

      await step("monitor", async () =>
        pollForEvents(deps, [docId, folderId].filter((id): id is string => Boolean(id)), pollAttempts, pollIntervalMs, sleep),
      );
    }
  } finally {
    if (subscriptionName && deps.unsubscribe) {
      await deps.unsubscribe(subscriptionName).catch(() => undefined);
    }
    if (folderId) {
      await deps.deleteFile(folderId).catch(() => undefined);
    }
  }

  const health = aggregateE2eHealth(results);
  const finishedAt = now().toISOString();
  const run: WorkspaceEventsE2eRun = {
    runId,
    startedAt,
    finishedAt,
    status: health === "healthy" ? "ok" : "fail",
    health,
    docId,
    folderId: folderId ?? null,
    subscriptionName,
    account: deps.accountEmail,
    tag,
    results,
  };

  await deps.persist?.(run);
  return run;
}

/**
 * List recent Workspace Events E2E runs, most-recent first.
 *
 * @param env - Worker bindings
 * @param limit - Max rows (capped at 20)
 * @returns Rehydrated run summaries
 */
export async function listWorkspaceEventsE2eRuns(
  env: Env,
  limit = 10,
): Promise<WorkspaceEventsE2eRun[]> {
  const db = getDb(env);
  const cap = Math.min(Math.max(limit, 1), 20);
  const rows = await db
    .select()
    .from(healthRuns)
    .where(sql`json_extract(${healthRuns.metadata}, '$.kind') = ${WORKSPACE_EVENTS_E2E_KIND}`)
    .orderBy(desc(healthRuns.createdAt))
    .limit(cap);

  return rows.map((row) => runFromHealthRow(row));
}

/**
 * Persist a run to `health_runs` + per-step `health_results`.
 *
 * @param env - Worker bindings
 * @param run - Completed E2E run
 * @param trigger - How the run was started
 */
export async function persistE2eRun(
  env: Env,
  run: WorkspaceEventsE2eRun,
  trigger: WorkspaceEventsE2eTrigger,
): Promise<void> {
  const db = getDb(env);
  const durationMs = Math.max(
    0,
    new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime(),
  );
  await db.insert(healthRuns).values({
    id: run.runId,
    status: run.health,
    trigger,
    durationMs,
    metadata: {
      kind: WORKSPACE_EVENTS_E2E_KIND,
      docId: run.docId,
      folderId: run.folderId,
      subscriptionName: run.subscriptionName,
      tag: run.tag,
      account: run.account,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      results: run.results,
    },
  });
  if (run.results.length > 0) {
    await db.insert(healthResults).values(
      run.results.map((step) => ({
        id: crypto.randomUUID(),
        runId: run.runId,
        category: "google" as const,
        name: `workspace_events_${step.action}`,
        status: step.status === "ok" ? ("ok" as const) : ("fail" as const),
        message: step.error ?? `${step.action} ${step.status}`,
        details: {
          docId: step.docId ?? run.docId,
          count: step.count,
          eventTypes: step.eventTypes,
          families: step.families,
          subscriptionName: step.subscriptionName ?? run.subscriptionName,
        },
        durationMs: step.durationMs,
      })),
    );
  }
}

async function pollForEvents(
  deps: WorkspaceEventsE2eDeps,
  resourceIds: string[],
  attempts: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<Partial<WorkspaceEventsE2eStep>> {
  const wanted = new Set<WorkspaceEventFamily>(["create", "change", "comment", "delete"]);
  let eventsFound: Array<Record<string, unknown>> = [];
  let eventTypes: string[] = [];
  let families: WorkspaceEventFamily[] = [];

  for (let i = 0; i < attempts; i++) {
    eventsFound = await deps.listNotificationsFor(resourceIds);
    eventTypes = uniqueTypes(eventsFound);
    families = [...new Set(eventTypes.map((t) => classifyEventFamily(t)))];
    const matched = families.filter((f) => wanted.has(f)).length;
    if (matched >= wanted.size) break;
    if (i < attempts - 1) await sleep(intervalMs);
  }

  if (eventsFound.length === 0) {
    return {
      status: "fail",
      count: 0,
      events: [],
      eventTypes: [],
      families: [],
      error: `No events received for ${resourceIds.join(", ")} within the poll window`,
    };
  }
  return { count: eventsFound.length, events: eventsFound, eventTypes, families };
}

function uniqueTypes(rows: Array<Record<string, unknown>>): string[] {
  const types = rows
    .map((row) => {
      const payload = asRecord(row.payload);
      return extractEventType(payload ?? {}) ?? (typeof row.resourceState === "string" ? row.resourceState : null);
    })
    .filter((t): t is string => Boolean(t));
  return [...new Set(types)];
}

function runFromHealthRow(row: typeof healthRuns.$inferSelect): WorkspaceEventsE2eRun {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const results = Array.isArray(meta.results) ? (meta.results as WorkspaceEventsE2eStep[]) : [];
  return {
    runId: row.id,
    startedAt: typeof meta.startedAt === "string" ? meta.startedAt : row.createdAt.toISOString(),
    finishedAt: typeof meta.finishedAt === "string" ? meta.finishedAt : row.createdAt.toISOString(),
    status: meta.status === "ok" ? "ok" : "fail",
    health: row.status,
    docId: typeof meta.docId === "string" ? meta.docId : null,
    folderId: typeof meta.folderId === "string" ? meta.folderId : undefined,
    subscriptionName: typeof meta.subscriptionName === "string" ? meta.subscriptionName : undefined,
    account: typeof meta.account === "string" ? meta.account : undefined,
    tag: typeof meta.tag === "string" ? meta.tag : undefined,
    results,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
