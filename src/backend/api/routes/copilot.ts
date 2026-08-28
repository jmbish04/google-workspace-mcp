/**
 * @fileoverview Copilot for the Apps Script sidebar. Mount at `/api/copilot`.
 *
 *   POST /token  { account?, fileId?, hostType? } (Bearer WORKER_API_KEY)
 *                → { token, expiresIn }   — short-lived, KV-backed
 *   POST /chat   { messages, account?, fileId?, hostType? }
 *                (Bearer WORKER_API_KEY  OR  a /token token)
 *                → { reply, account, steps }
 *   GET  /page   → the copilot HTML (iframe target); reads token+fileId+hostType
 *                  from the query and calls /chat.
 *
 * DESIGN: the GAS sidebar is a thin `<iframe src=".../api/copilot/page?token=…&fileId=…&hostType=doc">`.
 * `Code.gs` mints the token server-side (Bearer WORKER_API_KEY → /token) and
 * appends the ACTIVE file's Drive id, so the page is tailored to the document the
 * sidebar is attached to. The raw WORKER_API_KEY never travels in the iframe URL.
 *
 * `/chat` runs the OrchestratorAgent's full Workspace tool set via `generateText`
 * (multi-step, request/response).
 */
import { Hono } from "hono";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import { buildWorkspaceToolSet } from "@/backend/ai/agents/shared/merged-tools";
import { resolveAccount } from "@/backend/auth/provider";
import { getWorkerApiKey } from "@/backend/utils/secrets";
import { constantTimeEqual } from "@/backend/lib/crypto";
import { copilotPageHtml } from "./copilot-page";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

const TOKEN_PREFIX = "copilottok:";
const TOKEN_TTL = 3600; // 1h

interface CopilotContext {
  account?: string;
  fileId?: string;
  hostType?: string;
  /** Optional task hint (e.g. "review", "draft") — lets the server route to a
   * task-specific iframe page. */
  task?: string;
}

/** The worker's base URL — where the iframe pages are served from. */
function workerBase(c: { env: Env; req: { url: string; header: (k: string) => string | undefined } }): string {
  const configured = c.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  try {
    return new URL(c.req.url).origin;
  } catch {
    const host = c.req.header("host") ?? "";
    return host ? `https://${host}` : "";
  }
}

/**
 * The SINGLE server-side control point for what the sidebar iframe loads. The
 * worker owns the whole URL: which page, the token, and the query. Route to a
 * different source page per host type / task here as the copilot grows.
 */
function iframeUrl(base: string, token: string, ctx: CopilotContext): string {
  // (extend: pick a page path by ctx.hostType / ctx.task here)
  const page = "/api/copilot/page";
  const q = new URLSearchParams({ token });
  if (ctx.fileId) q.set("fileId", ctx.fileId);
  if (ctx.hostType) q.set("hostType", ctx.hostType);
  if (ctx.task) q.set("task", ctx.task);
  return `${base}${page}?${q.toString()}`;
}

const SYSTEM_BASE = `You are the Copilot for a Google Workspace automation platform, acting on behalf of the user across Gmail, Docs, Sheets, Slides, Drive, Apps Script, and Calendar — right inside the editor.

You have direct tools for every surface, named \`<surface>_<action>\`. Call them yourself.

Guidelines:
- Every tool accepts an optional \`account\` argument ('workspace' = default, 'personal', or an email). Pass \`account: 'personal'\` for the user's personal Gmail/Drive; omit it otherwise.
- Plan multi-step work and chain tools across surfaces in one turn.
- Prefer reading/searching before mutating; confirm destructive actions in your summary.
- When you create or modify a Google file, include its link/id.
- Be concise — surface the concrete result, not a narration of every tool call.`;

function systemPrompt(ctx: CopilotContext): string {
  if (!ctx.fileId) return SYSTEM_BASE;
  const kind = ctx.hostType || "document";
  return `${SYSTEM_BASE}

CONTEXT: You are attached to the ${kind} the user is currently editing — Drive id \`${ctx.fileId}\`. When the user says "this ${kind}", "here", or gives no explicit target, operate on THAT file (pass its id to the relevant tool). Only act on other files when the user names them.`;
}

/** Resolve the caller: full WORKER_API_KEY, or a short-lived /token (returns its stored context). */
async function authorize(c: { env: Env; req: { header: (k: string) => string | undefined } }): Promise<
  { ok: false } | { ok: true; ctx: CopilotContext }
> {
  const provided = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!provided) return { ok: false };
  const key = await getWorkerApiKey(c.env);
  if (key && constantTimeEqual(provided, key)) return { ok: true, ctx: {} };
  try {
    const raw = await c.env.SESSIONS.get(TOKEN_PREFIX + provided);
    if (raw) return { ok: true, ctx: JSON.parse(raw) as CopilotContext };
  } catch {
    /* no KV / bad token → unauthorized */
  }
  return { ok: false };
}

export const copilotRouter = new Hono<{ Bindings: Env }>();

copilotRouter.options("/chat", () => new Response(null, { headers: CORS }));
copilotRouter.options("/token", () => new Response(null, { headers: CORS }));

// Start a copilot session: mint a short-lived token AND return the COMPLETE
// iframe URL the sidebar should load. The server decides the page — GAS just
// drops `url` into the iframe src (no URL building on the GAS side).
copilotRouter.post("/token", async (c) => {
  const key = await getWorkerApiKey(c.env);
  const provided = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!key || !provided || !constantTimeEqual(provided, key)) return c.json({ error: "unauthorized" }, 401, CORS);
  const body = (await c.req.json().catch(() => ({}))) as CopilotContext;
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const ctx: CopilotContext = { account: body.account, fileId: body.fileId, hostType: body.hostType, task: body.task };
  await c.env.SESSIONS.put(TOKEN_PREFIX + token, JSON.stringify(ctx), { expirationTtl: TOKEN_TTL });
  return c.json({ url: iframeUrl(workerBase(c), token, ctx), token, expiresIn: TOKEN_TTL }, 200, CORS);
});

copilotRouter.post("/chat", async (c) => {
  const auth = await authorize(c);
  if (!auth.ok) return c.json({ error: "unauthorized" }, 401, CORS);

  const body = (await c.req.json().catch(() => ({}))) as { messages?: ModelMessage[] } & CopilotContext;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return c.json({ error: "messages[] required" }, 400, CORS);

  // Token context (if any) provides defaults; the request body can override.
  const ctx: CopilotContext = {
    account: body.account ?? auth.ctx.account,
    fileId: body.fileId ?? auth.ctx.fileId,
    hostType: body.hostType ?? auth.ctx.hostType,
  };
  const account = resolveAccount(c.env, ctx.account);
  const workersai = createWorkersAI({ binding: c.env.AI, gateway: { id: c.env.AI_GATEWAY_ID } });
  const model = workersai.chat((c.env.MODEL_CHAT as string) || "@cf/openai/gpt-oss-120b");

  try {
    const result = await generateText({
      model,
      system: systemPrompt(ctx),
      messages,
      tools: buildWorkspaceToolSet(c.env, account),
      stopWhen: stepCountIs(16),
    });
    return c.json({ reply: result.text, account, steps: result.steps?.length ?? 1 }, 200, CORS);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500, CORS);
  }
});

// The iframe target: a self-contained copilot page. Auth happens per /chat call
// with the token from the query, so this page itself is safe to serve.
copilotRouter.get("/page", (c) => {
  return c.html(copilotPageHtml());
});
