/**
 * @fileoverview Health check API routes for the Career Orchestrator Worker.
 *
 * Provides three endpoints:
 *  - `GET  /api/health`        — Quick liveness check (returns latest run from D1)
 *  - `GET  /api/health/latest` — Fetch the most recent run with all results
 *  - `POST /api/health/run`    — Run a full diagnostic, persist to D1, return results
 *
 * Uses the relational D1 schema (`health_runs` + `health_results`). The
 * `runAllChecks` path iterates every registered Durable Object agent binding,
 * opens a stub, calls a no-op `ping` RPC, and records latency per agent.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { desc, eq, sql } from "drizzle-orm";

import { healthRuns, healthResults } from "@db/schemas";
import { getDb } from "@/db";

// ---------------------------------------------------------------------------
// HealthCoordinator
// ---------------------------------------------------------------------------

type DOBindingDescriptor = {
  /** Hono binding key on `Env`. */
  binding: keyof Env;
  /** Friendly check name persisted to `health_results.name`. */
  name: string;
};

/**
 * Canonical list of Durable Object agent bindings the coordinator pings.
 *
 * One specialist Agents-SDK agent per Google surface (see wrangler.jsonc
 * `durable_objects.bindings`); `pingAgent` hits each one's `/__ping` and
 * treats any non-5xx response (including 404, if a binding has no such
 * route) as reachable.
 */
const AGENT_BINDINGS: DOBindingDescriptor[] = [
  { binding: "ORCHESTRATOR_AGENT", name: "orchestrator_agent_ping" },
  { binding: "GMAIL_AGENT", name: "gmail_agent_ping" },
  { binding: "DOCS_AGENT", name: "docs_agent_ping" },
  { binding: "SHEETS_AGENT", name: "sheets_agent_ping" },
  { binding: "SLIDES_AGENT", name: "slides_agent_ping" },
  { binding: "APPSSCRIPT_AGENT", name: "appsscript_agent_ping" },
  { binding: "DRIVE_AGENT", name: "drive_agent_ping" },
  { binding: "CALENDAR_AGENT", name: "calendar_agent_ping" },
];

const PING_TIMEOUT_MS = 2000;

type CheckResult = {
  category: "database" | "ai" | "agents" | "binding";
  name: string;
  status: "ok" | "warn" | "fail" | "skipped" | "timeout";
  message?: string;
  details?: Record<string, unknown>;
  durationMs: number;
};

class HealthCoordinator {
  constructor(private readonly env: Env) {}

  // -----------------------------------------------------------------------
  // GET helpers
  // -----------------------------------------------------------------------

  async getLatestRun() {
    const db = getDb(this.env);
    const [latest] = await db
      .select()
      .from(healthRuns)
      .where(
        sql`json_extract(${healthRuns.metadata}, '$.kind') IS NULL OR json_extract(${healthRuns.metadata}, '$.kind') != 'workspace_events_e2e'`,
      )
      .orderBy(desc(healthRuns.createdAt))
      .limit(1);

    if (!latest) return { run: null, results: [] as Array<typeof healthResults.$inferSelect> };

    const results = await db
      .select()
      .from(healthResults)
      .where(eq(healthResults.runId, latest.id));

    return { run: latest, results };
  }

  // -----------------------------------------------------------------------
  // Run all checks
  // -----------------------------------------------------------------------

  async runAllChecks(trigger: "manual" | "scheduled" | "agent") {
    const start = Date.now();

    // Each check is isolated. A health run that dies because ONE probe threw
    // reports nothing about the other eleven — the panel goes dark exactly
    // when something is wrong, which is the failure mode this whole module
    // exists to prevent. Measured 2026-10-03: POST /api/health/run returned
    // 500 in production while every individual route stayed 200.
    const checks = await Promise.all([
      this.isolate("database", "d1_roundtrip", () => this.checkD1()),
      this.isolate("ai", "workers_ai_binding", () => this.checkWorkersAI()),
      this.isolate("database", "draft_studio_tables", () => this.checkDraftStudio()),
      this.isolate("database", "postgres_hyperdrive", () => this.checkPostgres()),
      ...AGENT_BINDINGS.map((d) => this.isolate("agents", d.name, () => this.pingAgent(d))),
    ]);

    const durationMs = Date.now() - start;
    const status = aggregateStatus(checks);

    const runId = crypto.randomUUID();
    const db = getDb(this.env);

    // Persistence is a nice-to-have; the CALLER still gets the verdict even if
    // the history write fails. Previously a failed insert threw away a
    // complete, correct set of results.
    try {
      await this.persist(runId, status, trigger, durationMs, checks, db);
    } catch (error) {
      console.error("health: results could not be persisted", error);
      return {
        run: { id: runId, status, trigger, durationMs, createdAt: new Date(), metadata: { checkCount: checks.length, persisted: false } },
        results: checks.map((c) => ({ id: crypto.randomUUID(), runId, ...c })),
      } as unknown as Awaited<ReturnType<typeof this.getRunById>>;
    }
    return this.getRunById(runId);
  }

  /** Never let one probe's throw escape — turn it into a failed check. */
  private async isolate(
    category: string,
    name: string,
    run: () => Promise<CheckResult>,
  ): Promise<CheckResult> {
    const start = Date.now();
    try {
      return await run();
    } catch (error) {
      return {
        category,
        name,
        status: "fail",
        message: `check threw: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: Date.now() - start,
      } as CheckResult;
    }
  }

  private async persist(
    runId: string,
    status: ReturnType<typeof aggregateStatus>,
    trigger: "manual" | "scheduled" | "agent",
    durationMs: number,
    checks: CheckResult[],
    db: ReturnType<typeof getDb>,
  ) {
    await db.insert(healthRuns).values({
      id: runId,
      status,
      trigger,
      durationMs,
      metadata: { checkCount: checks.length },
    });

    if (checks.length > 0) {
      await db.insert(healthResults).values(
        checks.map((c) => ({
          id: crypto.randomUUID(),
          runId,
          category: c.category,
          name: c.name,
          status: c.status,
          message: c.message,
          details: c.details,
          durationMs: c.durationMs,
        })),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Individual checks
  // -----------------------------------------------------------------------

  private async checkD1(): Promise<CheckResult> {
    const start = Date.now();
    try {
      const result = await this.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return {
        category: "database",
        name: "d1_roundtrip",
        status: result?.ok === 1 ? "ok" : "warn",
        message: result?.ok === 1 ? "D1 responded with SELECT 1" : "Unexpected D1 response",
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        category: "database",
        name: "d1_roundtrip",
        status: "fail",
        message: error instanceof Error ? error.message : "Unknown D1 failure",
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * The draft studio. Reads every table it depends on rather than reporting
   * that a binding exists — a migration that never reached production fails
   * exactly here, and would otherwise only surface as a 500 the first time
   * someone opened a draft.
   *
   * Severity is split on purpose: the tables are the feature (`fail`), while
   * the live-update room only removes the automatic refresh (`warn`).
   */
  private async checkDraftStudio(): Promise<CheckResult> {
    const start = Date.now();
    try {
      await this.env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM email_drafts) + (SELECT COUNT(*) FROM email_draft_revisions) + (SELECT COUNT(*) FROM email_draft_comments) AS n",
      ).first<{ n: number }>();
    } catch (error) {
      return {
        category: "database",
        name: "draft_studio_tables",
        status: "fail",
        message: error instanceof Error ? error.message : "draft studio tables unreadable",
        durationMs: Date.now() - start,
      };
    }
    const ns = (this.env as unknown as { EMAIL_DRAFT_ROOM?: DurableObjectNamespace }).EMAIL_DRAFT_ROOM;
    if (!ns) {
      return {
        category: "database",
        name: "draft_studio_tables",
        status: "warn",
        message: "Tables readable, but EMAIL_DRAFT_ROOM is unbound — studio pages will not update live",
        durationMs: Date.now() - start,
      };
    }
    return {
      category: "database",
      name: "draft_studio_tables",
      status: "ok",
      message: "Draft studio tables readable and the live-update room is bound",
      durationMs: Date.now() - start,
    };
  }

  /**
   * Postgres through Hyperdrive — the system of record as of 2026-10-03.
   *
   * Runs a real query rather than reporting that a binding exists: the origin
   * is a box on a home LAN behind a Cloudflare Tunnel, so "bound" and
   * "reachable" are genuinely different facts. pgvector's presence is asserted
   * too, because RAG depends on it and a missing extension is otherwise only
   * discovered by the first embedding write.
   */
  private async checkPostgres(): Promise<CheckResult> {
    const start = Date.now();
    const base = { category: "database" as const, name: "postgres_hyperdrive" };
    if (!(this.env as { HYPERDRIVE?: unknown }).HYPERDRIVE) {
      return { ...base, status: "fail", message: "env.HYPERDRIVE is not bound", durationMs: Date.now() - start };
    }
    try {
      const { withPg } = await import("@/backend/db/postgres");
      // A health check MUST NOT be able to hang the request that runs it.
      // Measured 2026-10-03: without this bound, an unreachable origin left
      // postgres.js waiting and POST /api/health/run returned 500 for every
      // check, not just this one — the instrument took down the panel.
      const row = await withDeadline(
        POSTGRES_CHECK_TIMEOUT_MS,
        withPg(this.env, async (_db, sql) => {
          const r = await sql`select current_database() as db,
                                     (select extversion from pg_extension where extname = 'vector') as vector`;
          return r[0] as { db: string; vector: string | null };
        }),
      );
      if (!row?.db) {
        return { ...base, status: "fail", message: "Postgres answered but returned no row", durationMs: Date.now() - start };
      }
      if (!row.vector) {
        return {
          ...base,
          status: "warn",
          message: `Connected to ${row.db}, but pgvector is NOT installed — RAG writes will fail`,
          durationMs: Date.now() - start,
        };
      }
      return {
        ...base,
        status: "ok",
        message: `Connected to ${row.db} via Hyperdrive; pgvector ${row.vector}`,
        details: { database: row.db, pgvector: row.vector },
        durationMs: Date.now() - start,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Postgres unreachable through Hyperdrive";
      return {
        ...base,
        status: msg === POSTGRES_TIMEOUT_MESSAGE ? "timeout" : "fail",
        message: msg,
        durationMs: Date.now() - start,
      };
    }
  }

  private async checkWorkersAI(): Promise<CheckResult> {
    const start = Date.now();
    try {
      const binding = (this.env as unknown as { AI?: unknown }).AI;
      if (!binding) {
        return {
          category: "ai",
          name: "workers_ai_binding",
          status: "skipped",
          message: "env.AI binding not present",
          durationMs: Date.now() - start,
        };
      }
      return {
        category: "ai",
        name: "workers_ai_binding",
        status: "ok",
        message: "env.AI binding available",
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        category: "ai",
        name: "workers_ai_binding",
        status: "fail",
        message: error instanceof Error ? error.message : "Unknown AI binding failure",
        durationMs: Date.now() - start,
      };
    }
  }

  private async pingAgent(descriptor: DOBindingDescriptor): Promise<CheckResult> {
    const start = Date.now();
    const ns = (this.env as unknown as Record<string, unknown>)[descriptor.binding as string] as
      | DurableObjectNamespace
      | undefined;

    if (!ns || typeof ns.idFromName !== "function") {
      return {
        category: "binding",
        name: descriptor.name,
        status: "skipped",
        message: `Binding ${String(descriptor.binding)} is not present on env`,
        durationMs: Date.now() - start,
      };
    }

    try {
      const id = ns.idFromName("health-probe");
      const stub = ns.get(id);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

      const response = await stub.fetch("https://do.local/__ping", {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timer);

      const durationMs = Date.now() - start;
      // 404 is fine — it confirms the DO is reachable even if no /__ping route exists.
      const reachable = response.status < 500;
      return {
        category: "agents",
        name: descriptor.name,
        status: reachable ? "ok" : "fail",
        message: `${descriptor.binding as string} responded ${response.status}`,
        details: { status: response.status },
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - start;
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        category: "agents",
        name: descriptor.name,
        status: aborted ? "timeout" : "fail",
        message: error instanceof Error ? error.message : "Unknown DO failure",
        durationMs,
      };
    }
  }

  private async getRunById(runId: string) {
    const db = getDb(this.env);
    const [run] = await db.select().from(healthRuns).where(eq(healthRuns.id, runId)).limit(1);
    const results = await db
      .select()
      .from(healthResults)
      .where(eq(healthResults.runId, runId));
    return { run, results };
  }
}

function aggregateStatus(checks: CheckResult[]): "healthy" | "degraded" | "unhealthy" | "unknown" {
  if (checks.length === 0) return "unknown";
  const fails = checks.filter((c) => c.status === "fail" || c.status === "timeout").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  if (fails > 0) return "unhealthy";
  if (warns > 0) return "degraded";
  return "healthy";
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const checkStatusEnum = z.enum(["ok", "warn", "fail", "skipped", "timeout"]);
const healthStatusEnum = z.enum(["healthy", "degraded", "unhealthy", "unknown"]);
const triggerEnum = z.enum(["manual", "scheduled", "agent"]);
const categoryEnum = z.enum([
  "database",
  "ai",
  "providers",
  "agents",
  "google",
  "binding",
  "auth",
  "api",
  "custom",
]);

const healthResultSchema = z.object({
  id: z.string(),
  runId: z.string(),
  category: categoryEnum,
  name: z.string(),
  status: checkStatusEnum,
  message: z.string().nullish(),
  details: z.record(z.string(), z.unknown()).nullish(),
  durationMs: z.number(),
  aiSuggestion: z.string().nullish(),
  timestamp: z.union([z.string(), z.date()]),
});

const healthRunSchema = z.object({
  id: z.string(),
  status: healthStatusEnum,
  trigger: triggerEnum,
  durationMs: z.number(),
  createdAt: z.union([z.string(), z.date()]),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

const healthResponseSchema = z.object({
  run: healthRunSchema,
  results: z.array(healthResultSchema),
});

const latestResponseSchema = z.object({
  run: healthRunSchema.nullable(),
  results: z.array(healthResultSchema),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Budget for the Postgres probe: Hyperdrive cold start + the home tunnel. */
const POSTGRES_CHECK_TIMEOUT_MS = 6000;
const POSTGRES_TIMEOUT_MESSAGE = `Postgres did not answer within ${POSTGRES_CHECK_TIMEOUT_MS}ms through Hyperdrive`;

/**
 * Reject if `work` has not settled in time. The losing promise is left to
 * settle on its own — a health probe must bound the REQUEST, and cannot
 * cancel an in-flight socket.
 */
function withDeadline<T>(ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(POSTGRES_TIMEOUT_MESSAGE)), ms)),
  ]);
}

export const healthRouter = new OpenAPIHono<{ Bindings: Env }>();

/**
 * GET /api/health — Quick liveness / latest run.
 *
 * Returns the latest persisted run from D1 without re-running checks.
 * If no run exists yet, returns { run: null, results: [] }.
 */
healthRouter.openapi(
  createRoute({
    method: "get",
    path: "/",
    operationId: "healthCheck",
    responses: {
      200: {
        description: "Latest health run from D1 (no re-run)",
        content: { "application/json": { schema: latestResponseSchema } },
      },
    },
  }),
  async (c) => {
    const coordinator = new HealthCoordinator(c.env);
    const latest = await coordinator.getLatestRun();
    return c.json({ run: latest?.run ?? null, results: latest?.results ?? [] }, 200);
  },
);

/**
 * GET /api/health/latest — Same as GET / (explicit alias).
 */
healthRouter.openapi(
  createRoute({
    method: "get",
    path: "/latest",
    operationId: "getLatestHealthCheck",
    responses: {
      200: {
        description: "Most recent health run from D1",
        content: { "application/json": { schema: latestResponseSchema } },
      },
    },
  }),
  async (c) => {
    const coordinator = new HealthCoordinator(c.env);
    const latest = await coordinator.getLatestRun();
    return c.json({ run: latest?.run ?? null, results: latest?.results ?? [] }, 200);
  },
);

/**
 * POST /api/health/run — Explicit manual screening trigger.
 *
 * Runs all health checks (D1 roundtrip, Workers AI binding presence, every
 * registered agent DO ping) in parallel, persists run + results to D1, and
 * returns the full payload.
 */
healthRouter.openapi(
  createRoute({
    method: "post",
    path: "/run",
    operationId: "runHealthCheck",
    responses: {
      200: {
        description: "On-demand health diagnostic results",
        content: { "application/json": { schema: healthResponseSchema } },
      },
    },
  }),
  async (c) => {
    const coordinator = new HealthCoordinator(c.env);
    const { run, results } = await coordinator.runAllChecks("manual");
    return c.json({ run, results }, 200);
  },
);
