/**
 * @fileoverview HTTP surface for the on-demand Gmail verification harness.
 *
 * - `GET  /api/gmail-harness/health` — public liveness (`{ status: "ok" }`)
 * - `POST /api/gmail-harness/run`    — create a real draft on the DEPLOYED
 *   worker, read it back from Gmail, check it against the Gmail HTML standard,
 *   round-trip it through get/update, delete it. Returns every check with its
 *   severity and an overall `verdict`.
 *
 * `/run` needs the same credential as the other agent surfaces (`gsuite_session`
 * cookie, signed session Bearer, or `Bearer <WORKER_API_KEY>`): it writes to a
 * real mailbox. HTTP 503 when `verdict` is `fail`, so `curl -f` goes red too;
 * 200 for `pass`, `degraded` and `incomplete` — read `verdict`, never just the
 * status code. `plant` injects a known regression into the checked copy only
 * (`gmail/harness/plant.ts`) to prove a check can fail on the live worker.
 *
 * The harness logic lives in `@/backend/gmail/harness/run`; this file only
 * validates input, resolves the account and logs the result.
 *
 * @example
 * ```bash
 * curl -sS -X POST https://google-workspace-mcp.hacolby.workers.dev/api/gmail-harness/run \
 *   -H "Authorization: Bearer $WORKER_API_KEY" -H 'content-type: application/json' \
 *   -d '{"plant":"visible_ref"}'
 * ```
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import type { AppBindings } from "@/backend/api";
import { agentAuthMiddleware } from "@/backend/api/middleware/agent-auth";
import { resolveAccount } from "@/backend/auth/provider";
import { PLANTS } from "@/backend/gmail/harness/plant";
import { liveHarnessGmail, runGmailHarness } from "@/backend/gmail/harness/run";

const CheckSchema = z.object({
  name: z.string(),
  severity: z.enum(["critical", "major", "minor"]),
  status: z.enum(["pass", "fail", "skipped"]),
  message: z.string(),
});

const ReportSchema = z.object({
  runId: z.string(),
  verdict: z.enum(["pass", "degraded", "incomplete", "fail"]),
  account: z.string(),
  draftId: z.string().nullable(),
  uuid: z.string().nullable(),
  planted: z.enum(PLANTS).nullable(),
  durationMs: z.number(),
  summary: z.object({ pass: z.number(), fail: z.number(), skipped: z.number() }),
  checks: z.array(CheckSchema),
});

const RunBodySchema = z
  .object({
    as_user: z.string().optional().describe("Account to draft in; defaults to the worker's Workspace identity."),
    plant: z.enum(PLANTS).optional().describe("Plant one known regression into the checked copy (proves the check can fail)."),
    keep_draft: z.boolean().optional().describe("Leave the draft in Gmail for manual inspection."),
  })
  .strict();

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const HealthSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("gmail-harness"),
  timestamp: z.string(),
});

/** Router mounted at `/api/gmail-harness`. */
export const gmailHarnessRouter = new OpenAPIHono<AppBindings>();

gmailHarnessRouter.openapi(
  createRoute({
    method: "get",
    path: "/health",
    tags: ["Health"],
    summary: "Gmail harness liveness",
    operationId: "gmailHarnessLiveness",
    responses: { 200: { description: "Service is up", content: { "application/json": { schema: HealthSchema } } } },
  }),
  (c) => c.json({ status: "ok" as const, service: "gmail-harness" as const, timestamp: new Date().toISOString() }, 200),
);

gmailHarnessRouter.use("/run", agentAuthMiddleware);

gmailHarnessRouter.openapi(
  createRoute({
    method: "post",
    path: "/run",
    tags: ["Health"],
    summary: "Verify the deployed worker's Gmail output against the HTML standard",
    operationId: "gmailHarnessRun",
    request: { body: { required: false, content: { "application/json": { schema: RunBodySchema } } } },
    responses: {
      200: { description: "Verdict pass, degraded or incomplete", content: { "application/json": { schema: ReportSchema } } },
      400: { description: "Invalid body", content: { "application/json": { schema: ErrorSchema } } },
      503: { description: "Verdict fail", content: { "application/json": { schema: ReportSchema } } },
    },
  }),
  async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = RunBodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return c.json({ error: { code: "bad_request", message: parsed.error.message } }, 400);
    }
    const account = resolveAccount(c.env, parsed.data.as_user);
    const report = await runGmailHarness(liveHarnessGmail(c.env, account), {
      account,
      plant: parsed.data.plant,
      keepDraft: parsed.data.keep_draft,
    });
    console.log(
      JSON.stringify({
        event: "gmail_harness_finished",
        runId: report.runId,
        verdict: report.verdict,
        planted: report.planted,
        summary: report.summary,
        failed: report.checks.filter((x) => x.status === "fail").map((x) => `${x.severity}:${x.name}`),
      }),
    );
    return report.verdict === "fail" ? c.json(report, 503) : c.json(report, 200);
  },
);
