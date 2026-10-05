/**
 * @fileoverview `noStoreApiResponses` — stamp `Cache-Control: no-store` on any
 * `/api/*` response that does not set its own.
 *
 * `wrangler.jsonc` enables the Workers cache, which stores GET 200s that carry
 * no `Cache-Control`. Without this guard that cached a cookie-gated session
 * endpoint (`/api/agent-session/session`) and served one response to every
 * visitor, so AuthGate read a stale `authed:false` and locked out a logged-in
 * browser (and a cached `authed:true` would leak the other way). Routes that
 * intentionally cache (e.g. `/api/preview/*` images) set their own
 * `Cache-Control` first and are left untouched.
 */
import type { Context, Next } from "hono";

/** Hono middleware: default dynamic API responses to `no-store`. */
export async function noStoreApiResponses(c: Context, next: Next): Promise<void> {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
}
