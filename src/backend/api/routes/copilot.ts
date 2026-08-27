/**
 * @fileoverview Copilot chat endpoint for the Apps Script sidebar. Mount at
 * `/api/copilot`.
 *
 *   POST /chat  { messages: [{role, content}], account?, model? } → { reply, account }
 *
 * Request/response (no streaming) so a GAS `HtmlService` sidebar can drive it
 * with a plain `fetch`. It runs the SAME brain as the OrchestratorAgent — the
 * flattened Workspace tool set (`buildWorkspaceToolSet`) across Gmail/Docs/
 * Sheets/Slides/Drive/Apps Script/Calendar — via `generateText` (multi-step,
 * `stepCountIs(16)`).
 *
 * AUTH: `Authorization: Bearer <WORKER_API_KEY>` (constant-time). CORS is open,
 * but every call still needs the bearer, so the sidebar injects the key from its
 * GAS Script Properties at render time — it is never hardcoded in the repo. This
 * is single-tenant (the operator's own key + own OAuth accounts).
 */
import { Hono } from "hono";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import { buildWorkspaceToolSet } from "@/backend/ai/agents/shared/merged-tools";
import { resolveAccount } from "@/backend/auth/provider";
import { getWorkerApiKey } from "@/backend/utils/secrets";
import { constantTimeEqual } from "@/backend/lib/crypto";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

const SYSTEM = `You are the Copilot for a Google Workspace automation platform, acting on behalf of the user across Gmail, Docs, Sheets, Slides, Drive, Apps Script, and Calendar — right inside the document editor.

You have direct tools for every surface, named \`<surface>_<action>\` (e.g. \`gmail_searchMessages\`, \`sheets_writeRange\`, \`drive_search\`, \`calendar_createEvent\`). Call them yourself.

Guidelines:
- Every tool accepts an optional \`account\` argument ('workspace' = default, 'personal', or an email). Pass \`account: 'personal'\` for the user's personal Gmail/Drive; omit it otherwise.
- Plan multi-step work and chain tools across surfaces in one turn.
- Prefer reading/searching before mutating; confirm destructive actions in your summary.
- When you create or modify a Google file, include its link/id.
- If a step fails, report it plainly and continue with what's still possible.
- Be concise — surface the concrete result, not a narration of every tool call.`;

export const copilotRouter = new Hono<{ Bindings: Env }>();

copilotRouter.options("/chat", () => new Response(null, { headers: CORS }));

copilotRouter.post("/chat", async (c) => {
  const key = await getWorkerApiKey(c.env);
  const provided = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!key || !provided || !constantTimeEqual(provided, key)) {
    return c.json({ error: "unauthorized" }, 401, CORS);
  }

  const body = (await c.req.json().catch(() => ({}))) as { messages?: ModelMessage[]; account?: string; model?: string };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return c.json({ error: "messages[] required" }, 400, CORS);

  const account = resolveAccount(c.env, body.account);
  const workersai = createWorkersAI({ binding: c.env.AI, gateway: { id: c.env.AI_GATEWAY_ID } });
  const model = workersai.chat(body.model || (c.env.MODEL_CHAT as string) || "@cf/openai/gpt-oss-120b");

  try {
    const result = await generateText({
      model,
      system: SYSTEM,
      messages,
      tools: buildWorkspaceToolSet(c.env, account),
      stopWhen: stepCountIs(16),
    });
    return c.json({ reply: result.text, account, steps: result.steps?.length ?? 1 }, 200, CORS);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500, CORS);
  }
});
