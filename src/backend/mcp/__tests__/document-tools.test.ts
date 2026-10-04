/**
 * @fileoverview Registration guardrails for the agent document-editing tools.
 *
 * The review bar's hard rule: the document tools are registered in TOOLS but
 * the server stays code-mode-only — MCP_EXPOSED_TOOLS must remain exactly the
 * two code-mode tools. These assertions fail if a document tool is ever added
 * to the advertised surface, or if the family stops being registered at all.
 */
import { describe, it, expect } from "vitest";

// tools.ts pulls service modules that would otherwise touch the token
// provider / D1 at call time; stub them so importing the catalog is inert.
import { vi } from "vitest";
vi.mock("@/backend/mcp/tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));
vi.mock("@/backend/mcp/logging", () => ({
  logOperation: vi.fn(async () => {}),
  logAssetTouch: vi.fn(async () => {}),
}));

import { TOOLS, MCP_EXPOSED_TOOLS } from "@/backend/mcp/tools";
import { documentAgentTools } from "@/backend/mcp/document-tools";

const EXPECTED = [
  "document_list",
  "document_read",
  "document_create",
  "document_suggest",
  "document_suggest_batch",
  "document_comment",
  "document_comment_reply",
  "document_comment_resolve",
  "document_review_list",
  "document_suggestion_apply",
  "document_suggestion_withdraw",
];

describe("agent document tool registration", () => {
  it("registers every document tool in TOOLS", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const name of EXPECTED) expect(names.has(name), `missing ${name}`).toBe(true);
  });

  it("exposes NONE of them on the advertised surface (code-mode-only server)", () => {
    const exposed = new Set(MCP_EXPOSED_TOOLS.map((t) => t.name));
    expect([...exposed].sort()).toEqual(["code_mode_run", "code_mode_search"]);
    for (const name of EXPECTED) expect(exposed.has(name)).toBe(false);
  });

  it("keeps the two code-mode tools advertised", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    expect(names.has("code_mode_search")).toBe(true);
    expect(names.has("code_mode_run")).toBe(true);
  });

  it("gives each document tool an input and output schema", () => {
    for (const tool of documentAgentTools) {
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeTruthy();
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeTruthy();
    }
  });
});
