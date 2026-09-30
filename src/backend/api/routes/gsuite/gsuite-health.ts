/**
 * @fileoverview Health check route for the ported `HealthPanel` island,
 * ported from `core-gsuite-tools` Phase 3.
 *
 * MOUNTED AT `/api/gsuite-health` (not `/api/health`): this Worker already has
 * a richer `/api/health` (`healthRouter`, D1-persisted runs + per-agent DO
 * pings) with a DIFFERENT response shape. Rather than reshape `HealthPanel`
 * around that schema, this ports the SRC health probe as-is — it reuses
 * `db/health.ts` (`checkD1`) and `utils/health.ts` (`checkSecrets`,
 * `checkEnvVars`), which were already present in this Worker (ported ahead of
 * this phase) but unused by any route until now.
 *
 * Probes all live bindings: D1, KV (SESSIONS), secrets, and env vars. Returns
 * a structured status object suitable for uptime monitors.
 *
 * Route: GET /api/gsuite-health
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { checkD1 } from "@/backend/db/health";
import { checkSecrets, checkEnvVars } from "@/backend/utils/health";
import { getDb } from "@/backend/db";
import { googleAccounts } from "@db/schemas";
import { isReauthExposed } from "@/backend/lib/google-auth";
import { keepaliveGoogleTokens } from "@/backend/auth/oauth-keepalive";
import { countLiveSubscriptions } from "@/backend/workspace-events/subscription-manager";

/**
 * Workspace Events coverage, judged on what Google CONFIRMED.
 *
 * The first version of this check counted rows in our own table and reported
 * 252 for an account Google was holding about 100 subscriptions for. So the
 * verdict now keys on `verified` — rows a per-folder lookup confirmed inside
 * the freshness window — and unverified rows count against it rather than for
 * it. If that reads pessimistic right after a deploy, that is correct: nothing
 * has been proven yet.
 *
 * - fail: an account has no verified coverage at all, or anything abandoned
 *   (abandoned means we gave up recreating a folder's subscription because
 *   something upstream keeps dropping it — a real, sized problem).
 * - degraded: coverage exists but part of it is unproven or known-missing.
 * - ok: every row on every account is verified.
 */
async function checkWorkspaceSubscriptions(
  env: Env,
): Promise<{ status: "ok" | "fail" | "degraded"; accounts: unknown[] }> {
  const coverage = await countLiveSubscriptions(env);
  if (!coverage.length) return { status: "fail", accounts: [] };

  const anyBare = coverage.some((c) => c.verified === 0);
  const anyAbandoned = coverage.some((c) => c.abandoned > 0);
  if (anyBare || anyAbandoned) return { status: "fail", accounts: coverage };

  const anyUnproven = coverage.some((c) => c.unverified > 0 || c.missing > 0);
  return { status: anyUnproven ? "degraded" : "ok", accounts: coverage };
}

/**
 * Google OAuth liveness for every registered account.
 *
 * Default (cheap): report the status recorded in D1, which the weekly keepalive
 * cron and every real token refresh keep current. `?probe=1` forces a live
 * refresh-token exchange per account instead.
 *
 * Severity is the point: an account that cannot refresh makes this check
 * `"fail"`, which makes the whole response `"fail"`. A check that notices a
 * dead account and still returns ok is worse than no check.
 */
async function checkGoogleOAuth(
  env: Env,
  probe: boolean,
): Promise<{ status: "ok" | "fail" | "degraded"; accounts: unknown[] }> {
  if (probe) {
    const results = await keepaliveGoogleTokens(env);
    const anyDead = results.some((r) => !r.ok);
    const anyExposed = results.some((r) => r.reauthExposed);
    return {
      status: anyDead ? "fail" : anyExposed ? "degraded" : "ok",
      accounts: results,
    };
  }

  const rows = await getDb(env).select().from(googleAccounts);
  const accounts = rows.map((r) => {
    const scopes = Array.isArray(r.scopesJson) ? (r.scopesJson as string[]) : null;
    return {
      email: r.email,
      status: r.status,
      // A Cloud scope means this grant is under Workspace Google Cloud session
      // control and will keep dying until it is re-consented without them.
      reauthExposed: isReauthExposed(scopes),
    };
  });

  const anyDead = accounts.some((a) => a.status !== "active" && a.status !== "revoked");
  const anyExposed = accounts.some((a) => a.reauthExposed && a.status !== "revoked");
  return { status: anyDead ? "fail" : anyExposed ? "degraded" : "ok", accounts };
}

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/**
 * z.any() for health response: the rich union of ModuleResult subtypes returned
 * by check helpers would cause handler-type mismatch in @hono/zod-openapi if
 * described precisely. Explicit `200 as const` pins _status.
 */
const HealthSchema = z.any();

export const gsuiteHealthRouter = new OpenAPIHono<{ Bindings: Env }>();

gsuiteHealthRouter.openapi(createRoute({
  method: "get", path: "/",
  tags: ["Health"], summary: "Live binding health probe (ported gsuite hub)", operationId: "gsuiteHealthCheck",
  request: { query: z.object({ probe: z.string().optional() }) },
  responses: {
    200: { description: "Health status", content: { "application/json": { schema: HealthSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
}), async (c) => {
  const probe = c.req.query("probe") === "1";
  const [d1, kv, secrets, env, oauth, subscriptions] = await Promise.all([
    checkD1(c.env),
    // SESSIONS binding is the relevant KV for health checking
    (async () => {
      const start = Date.now();
      try {
        await c.env.SESSIONS.get("__health");
        return { status: "ok" as const, latencyMs: Date.now() - start };
      } catch (e) {
        return { status: "fail" as const, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
      }
    })(),
    checkSecrets(c.env),
    checkEnvVars(c.env),
    checkGoogleOAuth(c.env, probe),
    checkWorkspaceSubscriptions(c.env),
  ]);

  const modules = [d1, kv, secrets, env, oauth, subscriptions];
  const allOk = modules.every(r => r.status === "ok");
  const anyFail = modules.some(r => r.status === "fail");

  return c.json({
    status: allOk ? "ok" : anyFail ? "fail" : "degraded",
    timestamp: new Date().toISOString(),
    checks: { d1, kv, secrets, env, oauth, subscriptions },
  } as any, 200);
});
