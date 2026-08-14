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
 * Account selection mirrors the tools themselves: pass `as_user` (a signed-in
 * account's email) in the body to act as that account; omit it to act as the
 * first active account. There is no domain-wide delegation — every account is a
 * regular signed-in OAuth account.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import { TOOLS } from "@/backend/mcp/tools";
import { runTool } from "@/backend/mcp/tool-runner";
import { logOperation, logAssetTouch } from "@/backend/mcp/logging";
import { listCaptureAccounts } from "@/backend/gmail/sync-service";

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

/**
 * Resolve the `sub` a bridged call acts as. When the args carry `as_user`, the
 * tool's own `acct()` uses that email and `sub` is irrelevant, so any value is
 * fine. Otherwise fall back to the first active account. Throws a clear error
 * when no account is signed in.
 */
async function resolveSub(env: Env, args: { as_user?: unknown }): Promise<string> {
  if (typeof args?.as_user === "string" && args.as_user) return `api:${args.as_user}`;
  const accounts = await listCaptureAccounts(env);
  if (!accounts.length) {
    throw new Error("No signed-in Google account. Sign in at /api/auth/google/oauth/start, or pass `as_user`.");
  }
  return accounts[0].ref;
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

  let raw: unknown;
  try {
    raw = c.req.header("content-length") === "0" ? {} : await c.req.json();
  } catch {
    return c.json({ error: "Body must be a JSON object of tool arguments." }, 400);
  }

  const parsed = tool.inputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json({ error: "Invalid arguments", issues: parsed.error.issues }, 400);
  }

  const sub = await resolveSub(c.env, parsed.data);
  const started = Date.now();
  try {
    const { result, asset } = await runTool(tool, { env: c.env, sub }, parsed.data);
    // Log the same way the /mcp dispatch does so API-driven actions show up in
    // the operations log + assets feed. Key names only — never arg values.
    await logOperation(c.env, { toolName: tool.name, request: { keys: Object.keys(parsed.data ?? {}) }, success: true, latencyMs: Date.now() - started });
    if (asset) await logAssetTouch(c.env, { userSub: sub, toolName: tool.name, ...asset });
    return c.json({ result });
  } catch (err) {
    await logOperation(c.env, { toolName: tool.name, request: { keys: Object.keys(parsed.data ?? {}) }, success: false, latencyMs: Date.now() - started });
    throw err;
  }
});
