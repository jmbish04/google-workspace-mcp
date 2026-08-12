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
