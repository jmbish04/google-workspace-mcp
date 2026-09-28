/**
 * @fileoverview Serve short-lived doc previews from R2. Mount at `/api/preview`.
 *   GET /:id  → the PNG or PDF (gated by session cookie OR worker key).
 * The id is self-describing (`{uuid}-p1.png`, `{uuid}.pdf`) and IS the R2 object
 * key (dedicated previews bucket, no prefix). Objects are purged after 48h.
 */
import { Hono } from "hono";

import { getWorkerApiKey } from "@/backend/utils/secrets";
import { constantTimeEqual } from "@/backend/lib/crypto";
import { readVerifiedSession } from "@/backend/auth/read-session";
import { previewContentType } from "@/backend/docs/preview-store";

export const previewRouter = new Hono<{ Bindings: Env }>();

previewRouter.get("/:id", async (c) => {
  const key = await getWorkerApiKey(c.env);
  const provided = c.req.header("x-worker-key") ?? (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const keyed = !!key && !!provided && constantTimeEqual(provided, key);
  const authed = keyed || (await readVerifiedSession(c.env, c.req.raw)).authed;
  if (!authed) return c.json({ error: "unauthorized" }, 401);

  const id = c.req.param("id");
  const obj = await c.env.R2_PREVIEWS_BUCKET.get(id);
  if (!obj) return c.json({ error: "expired" }, 404);

  return new Response(obj.body, {
    headers: { "content-type": previewContentType(id), "cache-control": "private, max-age=3600" },
  });
});
