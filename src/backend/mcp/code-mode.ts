/**
 * @file mcp/code-mode.ts
 * @description "Code mode" for the MCP tool catalog (per Cloudflare's Code Mode
 * pattern): instead of the model invoking tools one JSON-RPC call at a time, it
 * writes a JavaScript snippet that calls `await tools.<name>(args)`, chains
 * results, and returns a value — executed once in an isolated dynamic Worker.
 *
 * ## Isolation
 * The snippet runs in a `WORKER_LOADERS` sandbox with:
 *   - `globalOutbound: null` — NO direct network egress (`fetch` is dead); the
 *     snippet's only capability is the tool bridge.
 *   - `env` limited to `{ TOOLS, SUB }` — the sandbox never sees this Worker's
 *     secrets or bindings. `TOOLS` is an RPC stub to `GsuiteService.callTool`
 *     (the `SELF_RPC` self service-binding), which executes the real tool in the
 *     host with full env; `SUB` is the caller's identity so tools act as them.
 *   - resource `limits` (cpuMs / subRequests) to bound a runaway snippet.
 *
 * So model-authored code can do everything the tools allow — and nothing else.
 */
import { z } from "zod";

import { TOOLS } from "./tools";

export interface CodeModeToolInfo {
  name: string;
  description: string;
}

/** The callable tools, for the model to discover what `tools.*` exposes.
 * The `code_mode_*` meta-tools are omitted (they drive code mode, not called from it). */
export function toolCatalog(): CodeModeToolInfo[] {
  return TOOLS.filter((t) => !t.name.startsWith("code_mode")).map((t) => ({ name: t.name, description: t.description }));
}

/** A catalog entry with its JSON-Schema input shape, for in-sandbox search/describe. */
export interface CodeModeToolDetail extends CodeModeToolInfo {
  inputSchema: unknown;
}

/**
 * Full tool catalog WITH JSON-Schema input shapes. This is what `codemode.tools()`
 * returns INSIDE the search sandbox — it stays in the sandbox; only the model's
 * filtered return value ever enters the model context (Cloudflare "search"
 * pattern: an entire API surface for ~1,000 context tokens).
 */
export function toolCatalogDetailed(): CodeModeToolDetail[] {
  return TOOLS.filter((t) => !t.name.startsWith("code_mode")).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.inputSchema),
  }));
}

/** Human-readable usage guide for the code-mode sandbox (`tools.*` proxy). */
export function apiGuide(): string {
  return [
    "# Code mode",
    "",
    "Write a JavaScript function body. An async `tools` object is in scope:",
    "",
    "  const threads = await tools.gmail_list({ query: 'is:unread', maxResults: 5 });",
    "  const first = await tools.gmail_get_thread({ threadId: threads.messages[0].threadId });",
    "  return { count: threads.messages.length, subject: first.messages[0]?.snippet };",
    "",
    "Rules:",
    "- Call any tool as `await tools.<tool_name>(argsObject)`; it returns that tool's `result`.",
    "- Every tool accepts the same args as its MCP schema, including optional `as_user`.",
    "- `return` your final value (JSON-serializable). Use `console.log(...)` for debug output.",
    "- The sandbox has NO network access and NO secrets — only `tools.*` reaches the outside world.",
    "- Errors thrown (including tool errors) are returned as `{ ok:false, error }`.",
    "",
    "## Markdown → Google Docs (two SEPARATE methods)",
    "- `docs_create_from_markdown({ name, markdown })` — Method 1: Drive's native importer turns a WHOLE Markdown string into a NEW doc (high fidelity: tables, lists, links). New doc only.",
    "- `docs_append_markdown({ documentId, markdown })` — Method 2: our own Markdown→batchUpdate mapping APPENDS to an EXISTING doc (headings/bold/italic/code/lists; no tables/images).",
    "  Pick by intent: creating a doc from Markdown → method 1; adding Markdown into a doc that already exists → method 2.",
  ].join("\n");
}

/**
 * Wrap a user snippet as an ES module whose default fetch handler runs the code
 * with a `tools` proxy (bridged over RPC) and captures the return value + logs.
 * The snippet is embedded as real module source (Workers block eval/new Function).
 */
export function buildHarnessModule(userCode: string): string {
  return `
function __fmt(v) {
  try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); }
}
export default {
  async fetch(_request, env) {
    const logs = [];
    const console = {
      log: (...a) => logs.push(a.map(__fmt).join(" ")),
      error: (...a) => logs.push("ERROR: " + a.map(__fmt).join(" ")),
      warn: (...a) => logs.push("WARN: " + a.map(__fmt).join(" ")),
      info: (...a) => logs.push(a.map(__fmt).join(" ")),
    };
    const tools = new Proxy({}, {
      get(_t, name) {
        if (typeof name !== "string") return undefined;
        return (args) => env.TOOLS.callTool(name, args ?? {}, env.SUB);
      },
    });
    try {
      const __result = await (async () => {
/* ==== user code ==== */
${userCode}
/* ==== end user code ==== */
      })();
      return Response.json({ ok: true, result: __result ?? null, logs });
    } catch (err) {
      return Response.json({ ok: false, error: err && err.message ? err.message : String(err), logs });
    }
  },
};
`;
}

/**
 * Search harness: like {@link buildHarnessModule}, but instead of a `tools`
 * bridge it exposes a read-only `codemode.tools()` returning the full detailed
 * catalog (passed in as a JSON string env var — never in module source, so tool
 * descriptions containing backticks can't break the sandbox). No network, no
 * tool execution, no secrets — discovery only.
 */
export function buildSearchModule(userCode: string): string {
  return `
function __fmt(v) {
  try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); }
}
export default {
  async fetch(_request, env) {
    const logs = [];
    const console = {
      log: (...a) => logs.push(a.map(__fmt).join(" ")),
      error: (...a) => logs.push("ERROR: " + a.map(__fmt).join(" ")),
      warn: (...a) => logs.push("WARN: " + a.map(__fmt).join(" ")),
      info: (...a) => logs.push(a.map(__fmt).join(" ")),
    };
    let __catalog = null;
    const codemode = { tools: () => { if (!__catalog) __catalog = JSON.parse(env.CATALOG_JSON); return __catalog; } };
    try {
      const __result = await (async () => {
/* ==== user code ==== */
${userCode}
/* ==== end user code ==== */
      })();
      return Response.json({ ok: true, result: __result ?? null, logs });
    } catch (err) {
      return Response.json({ ok: false, error: err && err.message ? err.message : String(err), logs });
    }
  },
};
`;
}

export interface CodeModeResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string[];
}

/** Short hex digest, used as a stable dynamic-worker id for identical snippets. */
async function shortHash(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Run a code-mode snippet in an isolated dynamic Worker and return its result.
 *
 * @param sub - caller identity; tools run as this account (unless a call passes `as_user`)
 * @param code - JavaScript function body using `tools.*`
 */
export async function runCodeMode(
  env: Env,
  sub: string,
  code: string,
  opts: { cpuMs?: number; subRequests?: number } = {},
): Promise<CodeModeResult> {
  const loader = env.WORKER_LOADERS;
  if (!loader) throw new Error("WORKER_LOADERS binding not configured — code mode is unavailable.");
  const rpc = env.SELF_RPC;
  if (!rpc) throw new Error("SELF_RPC service binding not configured — code mode is unavailable.");

  const module = buildHarnessModule(code);
  const stub = loader.get(`codemode:${await shortHash(code)}`, () => ({
    compatibilityDate: "2025-01-01",
    mainModule: "main.js",
    modules: { "main.js": module },
    // Only the tool bridge is reachable; the internet is not.
    globalOutbound: null,
    env: { TOOLS: rpc, SUB: sub },
    limits: { cpuMs: opts.cpuMs ?? 30_000, subRequests: opts.subRequests ?? 50 },
  }));

  const res = await stub.getEntrypoint().fetch(new Request("https://code-mode.internal/run", { method: "POST" }));
  return (await res.json()) as CodeModeResult;
}

/**
 * Run a code-mode SEARCH snippet: model JS that inspects `codemode.tools()` (the
 * full detailed catalog) and returns only the subset it needs. The catalog lives
 * inside the sandbox (via a JSON env var); only the return value comes back — so
 * discovery costs a few tokens instead of dumping every tool description.
 */
export async function runCodeModeSearch(
  env: Env,
  code: string,
  opts: { cpuMs?: number; subRequests?: number } = {},
): Promise<CodeModeResult> {
  const loader = env.WORKER_LOADERS;
  if (!loader) throw new Error("WORKER_LOADERS binding not configured — code mode is unavailable.");

  const module = buildSearchModule(code);
  const catalogJson = JSON.stringify(toolCatalogDetailed());
  const stub = loader.get(`codemode-search:${await shortHash(code)}`, () => ({
    compatibilityDate: "2025-01-01",
    mainModule: "main.js",
    modules: { "main.js": module },
    // Discovery only: no tool bridge, no network, no secrets.
    globalOutbound: null,
    env: { CATALOG_JSON: catalogJson },
    limits: { cpuMs: opts.cpuMs ?? 10_000, subRequests: opts.subRequests ?? 1 },
  }));

  const res = await stub.getEntrypoint().fetch(new Request("https://code-mode.internal/search", { method: "POST" }));
  return (await res.json()) as CodeModeResult;
}
