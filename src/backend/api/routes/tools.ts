/**
 * @fileoverview `/api/tools/*` — the generic REST bridge that gives every MCP
 * tool an HTTP equivalent, so anything callable over `/mcp` (code-mode) is also
 * callable over plain REST. This is the parity layer: the `/mcp` surface only
 * advertises the two `code_mode_*` meta-tools, and the full ~140-tool catalog
 * (Drive, Docs, Sheets, Slides, Gmail, Calendar, …) is otherwise reachable only
 * from inside the code-mode sandbox. These routes expose that same catalog
 * directly.
 *
 * Routes (gated by `agentAuthMiddleware` in `api/index.ts` — the browser
 * `gsuite_session` cookie OR `Authorization: Bearer <WORKER_API_KEY>`):
 *   GET  /api/tools           — list every callable tool + its JSON-Schema input
 *   GET  /api/tools/:name     — one tool's schema
 *   POST /api/tools/:name     — run the tool; body = tool args JSON → `{ result }`
 *
 * Account selection: pass `as_user` (a signed-in account's email) in the body
 * to act as that account; omit it to act as the first active account. `as_user`
 * must name an ACTIVE account — there is no domain-wide delegation, and this
 * prevents impersonating an arbitrary domain user.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import { TOOLS } from "@/backend/mcp/tools";
import { runTool } from "@/backend/mcp/tool-runner";
import { logOperation, logAssetTouch } from "@/backend/mcp/logging";
import { GoogleApiError } from "@/backend/mcp/googleClient";

import { resolveActingRef } from "../lib/acting-account";
import type { AppBindings } from "../index";

export const toolsRouter = new OpenAPIHono<AppBindings>();

/**
 * Tools reachable over this bridge — the same set code-mode can call (the
 * `code_mode_*` meta-tools are excluded: they only make sense inside the
 * sandbox and would recurse).
 */
const CALLABLE_TOOLS = TOOLS.filter((t) => !t.name.startsWith("code_mode"));
const TOOL_BY_NAME = new Map(CALLABLE_TOOLS.map((t) => [t.name, t]));

function describe(t: (typeof CALLABLE_TOOLS)[number]) {
  return {
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.inputSchema),
    outputSchema: t.outputSchema ? z.toJSONSchema(t.outputSchema) : undefined,
  };
}

/** GET /api/tools — full callable catalog with JSON-Schema shapes. */
toolsRouter.get("/", (c) => c.json({ tools: CALLABLE_TOOLS.map(describe) }));

/** GET /api/tools/:name — one tool's schema. */
toolsRouter.get("/:name", (c) => {
  const tool = TOOL_BY_NAME.get(c.req.param("name"));
  if (!tool) return c.json({ error: `Unknown tool: ${c.req.param("name")}` }, 404);
  return c.json(describe(tool));
});

/** POST /api/tools/:name — run the tool with the JSON body as its arguments. */
toolsRouter.post("/:name", async (c) => {
  const name = c.req.param("name");
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return c.json({ error: `Unknown tool: ${name}` }, 404);

  // Empty (or unparseable-but-empty) body → no args; let the schema decide, so
  // zero-arg tools work without an explicit `{}`.
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json({ error: "Body must be a JSON object of tool arguments." }, 400);
    }
  }

  const parsed = tool.inputSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid arguments", issues: parsed.error.issues }, 400);
  }

  // Act as a real active account (validates `as_user`); drop `as_user` so the
  // tool resolves the account from `sub` directly and assets key by that ref.
  const asUser = typeof parsed.data.as_user === "string" ? parsed.data.as_user : undefined;
  const sub = await resolveActingRef(c.env, asUser);
  const { as_user: _dropped, ...args } = parsed.data;

  const started = Date.now();
  try {
    const { result, asset } = await runTool(tool, { env: c.env, sub }, args);
    // Log the same way the /mcp dispatch does so API-driven actions show up in
    // the operations log + assets feed. Key names only — never arg values.
    await logOperation(c.env, { toolName: tool.name, request: { keys: Object.keys(args) }, success: true, latencyMs: Date.now() - started });
    if (asset) await logAssetTouch(c.env, { userSub: sub, toolName: tool.name, ...asset });
    return c.json({ result });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await logOperation(c.env, { toolName: tool.name, request: { keys: Object.keys(args) }, success: false, errorMessage, latencyMs: Date.now() - started });
    // Don't mirror an upstream Google status (401/403/404) onto our response —
    // it would be indistinguishable from this API's own auth rejection and can
    // leak the upstream body. Surface a sanitized 502 instead.
    if (err instanceof GoogleApiError) {
      return c.json({ error: `Upstream Google API error (${err.status}).` }, 502);
    }
    throw err;
  }
});
