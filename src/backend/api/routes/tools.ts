/**
 * @fileoverview `/api/tools/*` — the generic REST bridge that gives every MCP
 * tool an HTTP equivalent, so anything callable over `/mcp` (code-mode) is also
 * callable over plain REST. This is the parity layer: the `/mcp` surface only
 * advertises the two `code_mode_*` meta-tools, and the full ~140-tool catalog
 * (Drive, Docs, Sheets, Slides, Gmail, Calendar, …) is otherwise reachable only
 * from inside the code-mode sandbox. These routes expose that same catalog
 * directly — AND document each tool as its own operation in `/openapi.json`, so
 * an OpenAPI client (GPT Actions, codegen, Scalar/Swagger) can discover and call
 * every capability (bulk upload, sharing add/revoke, anyone-with-link, …) with
 * its real input schema.
 *
 * Routes (gated by `agentAuthMiddleware` in `api/index.ts` — the browser
 * `gsuite_session` cookie OR `Authorization: Bearer <WORKER_API_KEY>`):
 *   GET  /api/tools            — list every callable tool + its JSON-Schema input
 *   GET  /api/tools/:name      — one tool's schema (params/response shapes)
 *   POST /api/tools/<name>     — run the tool; body = tool args JSON → `{ result }`
 *                                (one documented operation per tool)
 *
 * Account selection: pass `as_user` (a signed-in account's email) in the body
 * to act as that account; omit it to act as the first active account. `as_user`
 * must name an ACTIVE account — there is no domain-wide delegation, and this
 * prevents impersonating an arbitrary domain user.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { TOOLS } from "@/backend/mcp/tools";
import { runTool } from "@/backend/mcp/tool-runner";
import { logOperation, logAssetTouch } from "@/backend/mcp/logging";
import { GoogleApiError } from "@/backend/mcp/googleClient";

import { resolveActingRef } from "../lib/acting-account";
import type { AppBindings } from "../index";

export const toolsRouter = new OpenAPIHono<AppBindings>({
  // Normalize framework request-body validation failures to the same shape
  // executeTool returns (and that the 400 response is documented with), instead
  // of leaking a raw ZodError object.
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ error: "Invalid arguments", issues: result.error.issues }, 400);
    }
  },
});

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
    inputSchema: z.toJSONSchema(t.inputSchema as unknown as z.ZodType),
    outputSchema: t.outputSchema ? z.toJSONSchema(t.outputSchema as unknown as z.ZodType) : undefined,
  };
}

const resultBody = z.object({ result: z.any() });
const errorBody = z.object({ error: z.string(), issues: z.array(z.any()).optional() });

/**
 * Run one tool against the request body. Shared by every per-tool POST route.
 * `rawArgs` is the (already framework-validated, when a body was sent) args
 * object; we re-validate to also cover the empty-body case for tools that have
 * required fields, and to strip `as_user` before dispatch.
 */
async function executeTool(
  c: Context<AppBindings>,
  tool: (typeof CALLABLE_TOOLS)[number],
  rawArgs: unknown,
) {
  const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) return c.json({ error: "Invalid arguments", issues: parsed.error.issues }, 400);

  // Act as a real active account (validates `as_user`); drop `as_user` so the
  // tool resolves the account from `sub` directly and assets key by that ref.
  const asUser = typeof parsed.data.as_user === "string" ? parsed.data.as_user : undefined;
  const sub = await resolveActingRef(c.env, asUser);
  const { as_user: _dropped, ...args } = parsed.data as Record<string, unknown>;

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
}

/** GET /api/tools — full callable catalog with JSON-Schema shapes. */
toolsRouter.get("/", (c) => c.json({ tools: CALLABLE_TOOLS.map(describe) }));

// POST /api/tools/<name> — one documented operation per tool, so /openapi.json
// advertises every capability with its real input schema (including `as_user`).
for (const tool of CALLABLE_TOOLS) {
  toolsRouter.openapi(
    createRoute({
      method: "post",
      path: `/${tool.name}`,
      tags: ["Tools"],
      operationId: `tool_${tool.name}`,
      summary: tool.description.length > 100 ? `${tool.description.slice(0, 97)}…` : tool.description,
      description: tool.description,
      request: {
        // Optional so zero-arg tools work with no body; required fields are
        // still enforced by executeTool's re-validation.
        body: { required: false, content: { "application/json": { schema: tool.inputSchema as unknown as z.ZodType } } },
      },
      responses: {
        200: { description: "Tool result", content: { "application/json": { schema: resultBody } } },
        400: { description: "Invalid arguments", content: { "application/json": { schema: errorBody } } },
        502: { description: "Upstream Google API error", content: { "application/json": { schema: errorBody } } },
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (c: any) => {
      // With required:false + no body, valid("json") is undefined → treat as {}.
      const body = (() => {
        try {
          return c.req.valid("json");
        } catch {
          return undefined;
        }
      })();
      return executeTool(c, tool, body);
    }) as never,
  );
}

/** GET /api/tools/:name — one tool's schema (kept last so it doesn't shadow POSTs). */
toolsRouter.get("/:name", (c) => {
  const tool = TOOL_BY_NAME.get(c.req.param("name"));
  if (!tool) return c.json({ error: `Unknown tool: ${c.req.param("name")}` }, 404);
  return c.json(describe(tool));
});
