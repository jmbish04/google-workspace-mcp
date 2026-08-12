import { describe, it, expect } from "vitest";
import { MCP_EXPOSED_TOOLS, TOOLS } from "../tools";

describe("tool catalog", () => {
  it("keeps the full drive/docs/sheets/gmail toolset available internally (code-mode sandbox)", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_files", "docs_create", "sheets_get_values", "gmail_send"]),
    );
    for (const t of TOOLS) {
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeDefined();
    }
  });

  it("exposes ONLY code-mode tools on the public MCP surface, each with an output schema", () => {
    expect(MCP_EXPOSED_TOOLS.map((t) => t.name)).toEqual(["code_mode_search", "code_mode_run"]);
    for (const tool of MCP_EXPOSED_TOOLS) {
      expect(tool.outputSchema).toBeDefined();
    }
  });
});
