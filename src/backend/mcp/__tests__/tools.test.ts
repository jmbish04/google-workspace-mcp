import { describe, it, expect } from "vitest";
import { MCP_EXPOSED_TOOLS, TOOLS } from "../tools";

describe("tool catalog", () => {
  it("exposes drive/docs/sheets/gmail tools with schemas", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_files", "docs_create", "sheets_get_values", "gmail_send"]),
    );
    for (const t of TOOLS) {
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeDefined();
    }
  });

  it("exposes only code-mode tools publicly, each with an output schema", () => {
    expect(MCP_EXPOSED_TOOLS.map((t) => t.name)).toEqual(["code_mode_api", "code_mode_run"]);
    for (const tool of MCP_EXPOSED_TOOLS) {
      expect(tool.outputSchema).toBeDefined();
    }
  });
});
