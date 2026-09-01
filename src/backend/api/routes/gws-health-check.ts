/**
 * @fileoverview HTTP surface for the Workspace Events E2E health probe.
 *
 * - `GET  /health`     — public liveness (`{ status: "ok" }`)
 * - `POST /run-e2e`    — create a folder, subscribe with descendants, create →
 *   rename → comment → delete a Doc, then poll `drive_notifications` until
 *   Pub/Sub events land (or the poll window ends)
 * - `GET  /results`    — recent persisted runs (most-recent first)
 *
 * `/run-e2e` and `/results` require a `gsuite_session` cookie or
 * `Authorization: Bearer <WORKER_API_KEY>` (same gate as other agent surfaces).
 * The probe itself lives in `@/backend/workspace-events/e2e` so MCP tools call
 * the same function without an HTTP loopback.
 *
 * @example
 * ```bash
 * curl -X POST https://google-workspace-mcp.hacolby.workers.dev/api/gws-health-check/run-e2e \
 *   -H "Authorization: Bearer $WORKER_API_KEY"
 * ```
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { agentAuthMiddleware } from "@/backend/api/middleware/agent-auth";
import {
  listWorkspaceEventsE2eRuns,
  runWorkspaceEventsE2e,
} from "@/backend/workspace-events/e2e";
import type { AppBindings } from "../index";

const ErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const StepResultSchema = z.object({
  action: z.string(),
  status: z.enum(["ok", "fail"]),
  durationMs: z.number().optional(),
  docId: z.string().optional(),
  subscriptionName: z.string().optional(),
  count: z.number().optional(),
  events: z.array(z.unknown()).optional(),
  eventTypes: z.array(z.string()).optional(),
  families: z.array(z.string()).optional(),
  error: z.string().optional(),
});

const E2eRunSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  status: z.enum(["ok", "fail"]),
  health: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
  docId: z.string().nullable(),
  folderId: z.string().nullable().optional(),
  subscriptionName: z.string().optional(),
  account: z.string().optional(),
  tag: z.string().optional(),
  results: z.array(StepResultSchema),
});

const ResultsSchema = z.object({
  runs: z.array(E2eRunSchema),
});

const HealthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("gws-health-check"),
  timestamp: z.string(),
});

export const gwsHealthCheckRouter = new OpenAPIHono<AppBindings>();

gwsHealthCheckRouter.openapi(
  createRoute({
    method: "get",
    path: "/health",
    tags: ["Health"],
    summary: "Workspace Events health-check liveness",
    operationId: "gwsHealthCheckLiveness",
    responses: {
      200: { description: "Service is up", content: { "application/json": { schema: HealthSchema } } },
    },
  }),
  async (c) => {
    return c.json(
      { status: "ok" as const, service: "gws-health-check" as const, timestamp: new Date().toISOString() },
      200,
    );
  },
);

gwsHealthCheckRouter.use("/run-e2e", agentAuthMiddleware);
gwsHealthCheckRouter.use("/results", agentAuthMiddleware);

gwsHealthCheckRouter.openapi(
  createRoute({
    method: "post",
    path: "/run-e2e",
    tags: ["Health"],
    summary: "Run E2E Workspace Events pipeline check",
    operationId: "gwsHealthCheckE2e",
    responses: {
      200: { description: "Health check result", content: { "application/json": { schema: E2eRunSchema } } },
      401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
      500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const trigger = c.req.header("x-e2e-trigger") === "agent" ? "agent" : "manual";
    let account: string | undefined;
    try {
      const body = (await c.req.json()) as { as_user?: string };
      if (typeof body?.as_user === "string" && body.as_user.includes("@")) account = body.as_user;
    } catch {
      // empty body is fine
    }
    const run = await runWorkspaceEventsE2e(c.env, { trigger, account });
    console.log(
      JSON.stringify({
        event: "workspace_events_e2e_finished",
        runId: run.runId,
        status: run.status,
        health: run.health,
        docId: run.docId,
        steps: run.results.map((s) => ({ action: s.action, status: s.status, count: s.count })),
      }),
    );
    return c.json(run, 200);
  },
);

gwsHealthCheckRouter.openapi(
  createRoute({
    method: "get",
    path: "/results",
    tags: ["Health"],
    summary: "List recent E2E Workspace Events check results",
    operationId: "gwsHealthCheckResults",
    request: {
      query: z.object({
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "List of runs", content: { "application/json": { schema: ResultsSchema } } },
      401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const limit = Math.min(Number(c.req.query("limit")) || 10, 20);
    const runs = await listWorkspaceEventsE2eRuns(c.env, limit);
    return c.json({ runs }, 200);
  },
);
