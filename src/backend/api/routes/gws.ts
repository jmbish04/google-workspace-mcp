/**
 * @fileoverview `/api/gws/*` — read-only routes feeding the Google Workspace
 * frontend pages: the MCP tool catalog, the operation log, and tracked
 * workspace assets (with their event history).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/db";
import { assetEvents, mcpLogs, workspaceAssets, scheduledSends, emailPreviews, emailTemplates } from "@db/schemas";
import { MCP_EXPOSED_TOOLS } from "@/backend/mcp/tools";
import { seedBuiltinTemplates } from "@/backend/gmail/email-templates";
import { inlineGmailStyles } from "@/backend/gmail/compose";
import { verifySessionCookie } from "@/backend/lib/cookies";

import type { AppBindings } from "../index";

export const gwsRouter = new OpenAPIHono<AppBindings>();

/** GET /tools — the public MCP (code-mode) catalog with JSON-Schema input + output shapes. */
gwsRouter.get("/tools", (c) =>
  c.json({
    tools: MCP_EXPOSED_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.inputSchema),
      outputSchema: t.outputSchema ? z.toJSONSchema(t.outputSchema) : undefined,
    })),
  }),
);

/** GET /operations?limit= — recent google-workspace MCP call log, newest first. Auth required. */
gwsRouter.get("/operations", async (c) => {
  const session = await verifySessionCookie(c.env, c.req.header("Cookie"));
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const limit = Number(c.req.query("limit") ?? "100");
  const db = getDb(c.env);
  const operations = await db
    .select()
    .from(mcpLogs)
    .where(eq(mcpLogs.serverName, "google-workspace"))
    .orderBy(desc(mcpLogs.createdAt))
    .limit(limit);
  return c.json({ operations });
});

/** GET /email-preview/:id — a hosted email-draft preview (id is an unguessable uuid; no auth). */
gwsRouter.get("/email-preview/:id", async (c) => {
  const [row] = await getDb(c.env).select().from(emailPreviews).where(eq(emailPreviews.id, c.req.param("id"))).limit(1);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ id: row.id, subject: row.subject, to: row.toAddr, account: row.account, html: row.html });
});

/** GET /email-templates — the email-template marketplace (built-ins + user). Public read. */
gwsRouter.get("/email-templates", async (c) => {
  await seedBuiltinTemplates(c.env);
  const rows = await getDb(c.env).select().from(emailTemplates);
  return c.json({
    templates: rows.map((t) => ({ id: t.id, name: t.name, description: t.description, category: t.category, isBuiltin: t.isBuiltin, html: t.html })),
  });
});

/** POST /email-templates — add a user template (sanitized + inlined). Auth required. */
gwsRouter.post("/email-templates", async (c) => {
  const session = await verifySessionCookie(c.env, c.req.header("Cookie"));
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; html?: string; description?: string; category?: string };
  if (!body.name || !body.html) return c.json({ error: "name and html are required" }, 400);
  const id = crypto.randomUUID();
  await getDb(c.env)
    .insert(emailTemplates)
    .values({ id, name: body.name, description: body.description ?? null, category: body.category ?? null, html: inlineGmailStyles(body.html), isBuiltin: false, createdBySub: session.sub });
  return c.json({ id, name: body.name });
});

/** GET /scheduled-sends — the scheduled Gmail send queue, newest schedule first. Auth required. */
gwsRouter.get("/scheduled-sends", async (c) => {
  const session = await verifySessionCookie(c.env, c.req.header("Cookie"));
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(scheduledSends)
    .orderBy(desc(scheduledSends.createdAt))
    .limit(200);
  return c.json({ scheduledSends: rows });
});

/** POST /scheduled-sends/:id/cancel — remove a not-yet-sent scheduled send. Auth required. */
gwsRouter.post("/scheduled-sends/:id/cancel", async (c) => {
  const session = await verifySessionCookie(c.env, c.req.header("Cookie"));
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid id" }, 400);
  }
  const db = getDb(c.env);
  const [row] = await db.select().from(scheduledSends).where(eq(scheduledSends.id, id)).limit(1);
  if (!row) {
    return c.json({ error: "Not found" }, 404);
  }
  if (row.sent) {
    return c.json({ error: "Already sent — cannot cancel" }, 409);
  }
  await db.delete(scheduledSends).where(eq(scheduledSends.id, id));
  return c.json({ ok: true, id });
});

/** GET /assets — the caller's tracked workspace assets, newest-touched first, with their events. Auth required. */
gwsRouter.get("/assets", async (c) => {
  const session = await verifySessionCookie(c.env, c.req.header("Cookie"));
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const db = getDb(c.env);
  const assets = await db
    .select()
    .from(workspaceAssets)
    .where(eq(workspaceAssets.userSub, session.sub))
    .orderBy(desc(workspaceAssets.lastTouchedAt))
    .limit(200);
  const events = await db
    .select()
    .from(assetEvents)
    .where(eq(assetEvents.userSub, session.sub))
    .orderBy(desc(assetEvents.createdAt))
    .limit(1000);

  const eventsByAsset = new Map<string, (typeof events)[number][]>();
  for (const event of events) {
    const bucket = eventsByAsset.get(event.assetId);
    if (bucket) bucket.push(event);
    else eventsByAsset.set(event.assetId, [event]);
  }

  return c.json({
    assets: assets.map((asset) => ({ ...asset, events: eventsByAsset.get(asset.id) ?? [] })),
  });
});
