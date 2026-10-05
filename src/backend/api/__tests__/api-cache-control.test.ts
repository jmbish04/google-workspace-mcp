/**
 * @fileoverview Regression: dynamic `/api/*` responses must carry
 * `Cache-Control: no-store`.
 *
 * `wrangler.jsonc` enables the Workers cache, which stores GET 200s that carry
 * no `Cache-Control`. That cached a cookie-gated session endpoint
 * (`/api/agent-session/session`) and served one response to every visitor, so
 * AuthGate read a stale `authed:false` and locked out a logged-in browser. The
 * `noStoreApiResponses` middleware stamps `no-store` on any `/api/*` response
 * that sets none, while leaving a route's own `Cache-Control` intact.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { noStoreApiResponses } from "../middleware/no-store";

function buildApp() {
  const app = new Hono();
  app.use("/api/*", noStoreApiResponses);
  app.get("/api/agent-session/session", (c) => c.json({ authed: false }));
  // A route that intentionally caches must keep its own header.
  app.get("/api/preview/x", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.body("img");
  });
  return app;
}

describe("noStoreApiResponses", () => {
  it("stamps no-store on an API response that sets no Cache-Control", async () => {
    const res = await buildApp().request("/api/agent-session/session");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("leaves a route's own Cache-Control untouched", async () => {
    const res = await buildApp().request("/api/preview/x");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });
});
