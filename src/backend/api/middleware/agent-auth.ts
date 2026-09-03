/**
 * @fileoverview Auth gate for the ported gsuite REST surfaces
 * (`/api/threads/*`, `/api/catalog/*`, `/api/agent-tasks/*`,
 * `/api/accounts/*`, `/api/gsuite-health/*`, `/api/gws-health-check/*`).
 *
 * These routes read chat/thread state, drive Google Workspace actions via the
 * agent DOs, and revoke OAuth credentials — see the C1 finding in the
 * 2026-07-25 security audit. They must accept exactly the same credentials as
 * the `/agents/*` Durable Object gate (`isAuthorizedAgentRequest` in
 * `src/_worker.ts`) so a caller who can reach the agents can also reach these
 * REST endpoints, and no one else can:
 *
 *  - the browser's `gsuite_session` cookie (`readVerifiedSession`), or
 *  - `Authorization: Bearer <WORKER_API_KEY>` (server-to-server), or
 *  - `Authorization: Bearer <signed session token>` (browser islands that
 *    read the non-HttpOnly cookie via `getSessionToken()`).
 *
 * Deliberately NOT accepted: query-string tokens (see I2 — they leak into
 * logs/Referer/history).
 */

import type { Context, Next } from "hono";

import type { Variables } from "@/backend/api/index";
import { readVerifiedSession } from "@/backend/auth/read-session";
import { verifySessionToken } from "@/backend/auth/session-token";
import { constantTimeEqual } from "@/backend/lib/crypto";
import { getWorkerApiKey } from "@/backend/utils/secrets";

/**
 * Reject the request unless it carries a valid `gsuite_session` cookie, the
 * raw `WORKER_API_KEY` as a bearer token, or a signed session token as Bearer
 * (same three paths as `isAuthorizedAgentRequest` in `src/_worker.ts`).
 *
 * @param c - Hono context (needs `Bindings: Env`)
 * @param next - Downstream handler
 * @returns 401 JSON `{ error: "Unauthorized" }` when no credential matches
 */
export async function agentAuthMiddleware(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
) {
  const { authed } = await readVerifiedSession(c.env, c.req.raw);
  if (authed) {
    await next();
    return;
  }

  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer) {
    const workerKey = await getWorkerApiKey(c.env);
    if (workerKey && constantTimeEqual(bearer, workerKey)) {
      await next();
      return;
    }
    if (await verifySessionToken(c.env, bearer)) {
      await next();
      return;
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
}
