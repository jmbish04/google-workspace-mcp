/**
 * @fileoverview Regression: the draft-studio REST surface must be gated by the
 * SAME credential the frontend carries — the `gsuite_session` cookie or a
 * Bearer token via `agentAuthMiddleware` — NOT the unrelated `cr_session`
 * admin cookie.
 *
 * The bug: `/api/email-drafts` self-gated on `cr_session` (which no browser
 * session ever mints — the frontend logs in through `/api/agent-session` and
 * gets `gsuite_session`), so every call 401'd and the "New draft" button did
 * nothing. These tests mount the router exactly as `api/index.ts` does and
 * assert a real browser session reaches the handler.
 *
 * Kept DB-free on purpose: an invalid body returns 400 *after* the auth gate,
 * so passing the gate is observable without a D1 binding. Before the fix a
 * valid `gsuite_session` still 401'd here; after it, it 400s.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { agentAuthMiddleware } from "@/backend/api/middleware/agent-auth";
import { mintSessionToken } from "@/backend/auth/session-token";

import { emailDraftsRouter } from "../email-drafts";

const env = { WORKER_API_KEY: "worker-secret" } as unknown as Env;

/** Mirror the mount in `api/index.ts`: base + sub-paths behind the gate. */
function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/api/email-drafts", agentAuthMiddleware);
  app.use("/api/email-drafts/*", agentAuthMiddleware);
  app.route("/api/email-drafts", emailDraftsRouter);
  return app;
}

/** `subject` must be a string — forces a 400 at the handler, no DB touched. */
const INVALID_BODY = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject: 123 }) };

describe("/api/email-drafts auth gate", () => {
  it("401s a POST with no credentials", async () => {
    const res = await buildApp().request("/api/email-drafts", INVALID_BODY, env);
    expect(res.status).toBe(401);
  });

  it("passes a POST carrying a valid gsuite_session cookie to the handler (400 invalid body, not 401)", async () => {
    const token = await mintSessionToken(env);
    expect(token).toBeTruthy();
    const res = await buildApp().request(
      "/api/email-drafts",
      { ...INVALID_BODY, headers: { ...INVALID_BODY.headers, cookie: `gsuite_session=${token}` } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("passes a POST carrying the WORKER_API_KEY bearer to the handler (400 invalid body, not 401)", async () => {
    const res = await buildApp().request(
      "/api/email-drafts",
      { ...INVALID_BODY, headers: { ...INVALID_BODY.headers, Authorization: "Bearer worker-secret" } },
      env,
    );
    expect(res.status).toBe(400);
  });
});
