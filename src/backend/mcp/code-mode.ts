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

import { buildDocsHelperSource } from "@/backend/mcp/sandbox-docs-helpers";

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
    "## `docs` helpers (pure, no network, no import needed)",
    "- `docs.outline(json, { tabId })` → `{ tabs:[{ tabId, endIndex, items:[{ kind, start, end, style, bullet, table, cell:[r,c], text }] }] }` (same as docs_outline); `docs.outlineLines(outline)` → compact lines.",
    "- `docs.find(json, text, { matchCase, tabId })` → every match `{ tabId, startIndex, endIndex, bold, inSuggestion, table, cell }` (same as docs_find).",
    "- Empty-table math for a table inserted at `insertAt` (the start of the empty paragraph it goes before): `docs.tableStart(insertAt)` = insertAt+1; `docs.cellIndex(insertAt, R, C, r, c)` = insertAt+4+r(2C+1)+2c; `docs.afterTable(insertAt, R, C)` = insertAt+3+R(2C+1) (the next insertAt); `docs.layoutTables(insertAt, [{ rows, columns }, …])` lays out consecutive tables.",
    "- Fill cells LAST to FIRST (`docs.fillOrder(cells)`) so earlier indices stay valid; `docs.finalCellStarts(cells, insertedLengths)` gives positions after all fills, for styles in the same batch. `docs.utf16Length(text)` counts UTF-16 units (emoji = 2).",
    "",
    "## Markdown → Google Docs (two SEPARATE methods)",
    "- `docs_create_from_markdown({ name, markdown })` — Method 1: Drive's native importer turns a WHOLE Markdown string into a NEW doc (high fidelity: tables, lists, links). New doc only.",
    "- `docs_append_markdown({ documentId, markdown })` — Method 2: our own Markdown→batchUpdate mapping APPENDS to an EXISTING doc (headings/bold/italic/code/lists; no tables/images).",
    "  Pick by intent: creating a doc from Markdown → method 1; adding Markdown into a doc that already exists → method 2.",
    "",
    "## Editing existing files — pick a mode BEFORE any write, and say which",
    "- Preserve (default): review, proofread, finalize, tighten, fix, update facts, \"I made changes, check them\". Use only formatting-safe tools: `docs_edit_text` (one occurrence, keeps its style); `docs_replace_text` only when `find` occurs exactly once (it replaces ALL occurrences); `slides_replace_all_text`; `sheets_update_values` and `sheets_append_values` (values only). Never recreate the document, delete and re-insert sections, apply markdown, change fonts, colours or heading styles, or reorder content the user did not ask to move.",
    "- Redesign: only when the user explicitly asks for the look to change (\"make it look better\", \"prettier\", \"redesign\", \"restyle\", \"modernize the layout\", \"be creative with formatting\"). Styling tools, raw batch updates and templates are allowed. Wording stays unless the user also asks for a rewrite.",
    "- Clarify: when intent is unclear (\"improve this section\"), ask one short question (content only, or the look too) and write nothing until answered.",
    "- Redesign-only tools (never in Preserve): docs_create_from_markdown, html_to_doc, docs_append_markdown, docs_batch_update, slides_create_from_markdown, slides_batch_update, sheets_batch_update, docs_style_text, slides_style_text, slides_style_shape, slides_set_slide_background, docs_qc_fix, instantiate_from_template.",
    "- Preserve check: before a write, read `docs_get_json` (the whole document) and inspect the target range within it; after the write, read again and confirm each affected text run's `textStyle` and each paragraph's `namedStyleType` are unchanged. If anything drifted, say so in the reply and point to version history.",
    "- Mixed styles: when `docs_edit_text` returns `{ ok:false, mixedStyles:true, runs }`, edit each run separately so bold stays bold and plain stays plain. It throws on a match containing a paragraph break — edit within one paragraph.",
    "- Pending suggestions: when `docs_edit_text` returns `{ ok:false, hasSuggestions:true, runs }`, the matched text carries a pending suggestion (tracked change) and nothing was written — editing it would rewrite text whose author has not had that suggestion accepted or rejected. Ask the user to resolve the suggestions in the document first, then retry; never edit around them. This is only about the matched text, not the rest of the document — other indices returned by `docs_get_json` are trustworthy.",
    "- Non-text spans: when `docs_edit_text` returns `{ ok:false, spansNonText:true, runs }`, the match contains something other than text (a footnote reference, inline image, person or date chip, rich link, auto-text or page break) and nothing was written. Pick a match that avoids the element — don't retry the same match, and don't fall back to rewriting the whole range.",
  ].join("\n");
}

/**
 * Wrap a user snippet as an ES module whose default fetch handler runs the code
 * with a `tools` proxy (bridged over RPC) and captures the return value + logs.
 * The snippet is embedded as real module source (Workers block eval/new Function).
 * A frozen, pure `docs` helper object (positions, outline, find) is declared
 * at the top of the module — see `sandbox-docs-helpers.ts`.
 */
export function buildHarnessModule(userCode: string): string {
  return `
${buildDocsHelperSource()}
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
