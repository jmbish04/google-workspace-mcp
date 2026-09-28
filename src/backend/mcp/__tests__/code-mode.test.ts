import { describe, it, expect } from "vitest";

import { buildHarnessModule, buildSearchModule, toolCatalog, toolCatalogDetailed, apiGuide } from "../code-mode";

describe("buildHarnessModule", () => {
  it("embeds the user code and exports a default fetch handler", () => {
    const mod = buildHarnessModule("return await tools.gmail_list({ maxResults: 1 });");
    expect(mod).toContain("export default");
    expect(mod).toContain("async fetch(_request, env)");
    expect(mod).toContain("return await tools.gmail_list({ maxResults: 1 });");
    expect(mod).toContain("env.TOOLS.callTool(name, args ?? {}, env.SUB)");
  });

  it("wraps user code inside the async result IIFE (return works)", () => {
    const mod = buildHarnessModule("return 42;");
    const start = mod.indexOf("const __result = await (async () => {");
    const end = mod.indexOf("})();", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(mod.slice(start, end)).toContain("return 42;");
  });
});

describe("toolCatalog", () => {
  const names = toolCatalog().map((t) => t.name);
  it("includes real tools", () => {
    expect(names).toContain("gmail_send");
    expect(names).toContain("drive_audit_sharing");
    expect(names).toContain("gmail_attachments_to_drive");
  });
  it("omits the code_mode meta-tools", () => {
    expect(names).not.toContain("code_mode_run");
    expect(names).not.toContain("code_mode_search");
  });
  it("carries a description for every tool", () => {
    expect(toolCatalog().every((t) => typeof t.description === "string" && t.description.length > 0)).toBe(true);
  });
});

describe("apiGuide", () => {
  it("documents the tools proxy usage", () => {
    const g = apiGuide();
    expect(g).toContain("await tools.");
    expect(g).toContain("return");
  });

  it("carries the Preserve / Redesign / Clarify editing policy", () => {
    const g = apiGuide();
    for (const s of [
      "Preserve (default)",
      "Redesign",
      "Clarify",
      "docs_edit_text",
      "sheets_update_values",
      "slides_replace_all_text",
      "only when `find` occurs exactly once",
      "mixedStyles",
      "hasSuggestions",
      "resolve the suggestions",
      "docs_get_json",
      "namedStyleType",
      "version history",
    ]) {
      expect(g).toContain(s);
    }
    for (const tool of [
      "docs_create_from_markdown", "html_to_doc", "docs_append_markdown", "docs_batch_update",
      "slides_create_from_markdown", "slides_batch_update", "sheets_batch_update", "docs_style_text",
      "slides_style_text", "slides_style_shape", "slides_set_slide_background", "docs_qc_fix",
      "instantiate_from_template",
    ]) {
      expect(g).toContain(tool);
    }
  });

  it("documents the spansNonText refusal alongside mixedStyles", () => {
    const g = apiGuide();
    expect(g).toContain("spansNonText");
    expect(g).toContain("footnote reference");
  });
});

describe("toolCatalogDetailed", () => {
  const detailed = toolCatalogDetailed();
  it("carries a JSON-Schema inputSchema per tool", () => {
    const gmailSend = detailed.find((t) => t.name === "gmail_send");
    expect(gmailSend).toBeDefined();
    expect(gmailSend!.inputSchema).toBeTypeOf("object");
    expect((gmailSend!.inputSchema as any).properties).toHaveProperty("to");
  });
  it("omits the code_mode meta-tools (same filter as toolCatalog)", () => {
    expect(detailed.map((t) => t.name)).not.toContain("code_mode_search");
    expect(detailed.map((t) => t.name)).not.toContain("code_mode_run");
  });
});

describe("buildSearchModule", () => {
  it("exposes a read-only codemode.tools() from the JSON env var — no tool bridge, no source-embedded catalog", () => {
    const mod = buildSearchModule("return codemode.tools().filter(t => t.name.includes('gmail'));");
    expect(mod).toContain("export default");
    expect(mod).toContain("JSON.parse(env.CATALOG_JSON)");
    expect(mod).toContain("codemode");
    // Search must NOT carry the execute bridge (that would let discovery run tools).
    expect(mod).not.toContain("env.TOOLS.callTool");
    expect(mod).toContain("return codemode.tools().filter(t => t.name.includes('gmail'));");
  });
});
