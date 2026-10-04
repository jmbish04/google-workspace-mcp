import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
/**
 * @fileoverview Tests for Phase 4 Document AI Assistant Surfaces (Tasks A & B).
 *
 * TASK A (5b868d0c8567): Dock sheet-10 as the document AI assistant
 * - sheet-10 docked to rich-text-editor-5 on the document
 * - Document-aware prompt suggestion chips (selection vs whole-document)
 * - Streamed output lands as tracked suggestions via review dock (never silent overwrite)
 *
 * TASK B (fc971ba732e1): Selection-scoped assistant actions
 * - Assistant acts on current selection as well as whole document
 * - Rewrites produce edits anchored to selection range with step trace
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { documentAssistantRouter } from "@/backend/api/routes/document-assistant";
import {
  planAction,
  matchAction,
  type AssistScope,
} from "@/components/blocks/rich-text-editor-5/components/assist-plans";
import {
  SUGGESTION_DELETE,
  SUGGESTION_INSERT,
} from "@/components/blocks/rich-text-editor-5/components/rich-text-changes";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("TASK A (5b868d0c8567): Dock sheet-10 as the document AI assistant", () => {
  it("docks sheet-10 AskReUISheet onto rich-text-editor-5 container", () => {
    const docAssistantSrc = read(
      "src/components/blocks/rich-text-editor-5/components/doc-assistant.tsx",
    );

    // Verify AskReUISheet import and docking
    expect(docAssistantSrc).toMatch(
      /import\s*\{\s*AskReUISheet\s*\}\s*from\s*["']@\/components\/blocks\/sheet-10\/components\/ask-reui-sheet["']/,
    );
    expect(docAssistantSrc).toContain("<AskReUISheet");
    expect(docAssistantSrc).toContain("editor={editor}");
    expect(docAssistantSrc).toContain("open={sheetOpen}");
    expect(docAssistantSrc).toContain("onOpenChange={setSheetOpen}");
  });

  it("sheet-10 uses ReUI Sheet primitives without hand-rolling custom drawers", () => {
    const sheetSrc = read("src/components/blocks/sheet-10/components/ask-reui-sheet.tsx");

    expect(sheetSrc).toMatch(/from\s*["']@\/components\/ui\/sheet["']/);
    expect(sheetSrc).toContain("SheetContent");
    expect(sheetSrc).toContain("SheetHeader");
    expect(sheetSrc).toContain("SheetTitle");
  });

  it("provides document-aware prompt suggestions (selection vs whole document)", async () => {
    const mockEnv = {
      AI_GATEWAY_TOKEN: "mock-token",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "mock-cf-token",
    };

    // When selection is active: document-aware chips tailored to selected text
    const selRes = await documentAssistantRouter.request(
      "/suggestions?hasSelection=true",
      { method: "GET" },
      mockEnv,
    );
    expect(selRes.status).toBe(200);
    const selBody = (await selRes.json()) as any;
    const selLabels = selBody.chips.map((s: { label: string }) => s.label);
    expect(selLabels).toContain("Tighten this paragraph");
    expect(selLabels).toContain("Make the tone firmer");
    expect(selLabels).toContain("Turn this into a bulleted list");
    expect(selLabels).toContain("Proofread selection");

    // When no selection: document-level chips tailored to entire document
    const docRes = await documentAssistantRouter.request(
      "/suggestions?hasSelection=false",
      { method: "GET" },
      mockEnv,
    );
    expect(docRes.status).toBe(200);
    const docBody = (await docRes.json()) as any;
    const docLabels = docBody.chips.map((s: { label: string }) => s.label);
    expect(docLabels).toContain("Draft executive summary");
    expect(docLabels).toContain("Tighten wordy sections");
    expect(docLabels).toContain("Extract launch checklist");
  });

  it("streamed edits land as tracked suggestions via richTextChanges (never silent overwrite)", () => {
    const streamSrc = read("src/components/blocks/rich-text-editor-5/components/assist-stream.ts");

    // Verify tracked redline suggestions are used instead of silent overwrite
    expect(streamSrc).toContain("SUGGESTION_DELETE");
    expect(streamSrc).toContain("SUGGESTION_INSERT");
    expect(streamSrc).toContain("dispatchAsAgent");

    // Verify marks exported from rich-text-changes
    expect(SUGGESTION_DELETE).toBe("suggestionDelete");
    expect(SUGGESTION_INSERT).toBe("suggestionInsert");
  });
});

describe("TASK B (fc971ba732e1): Selection-scoped assistant actions", () => {
  function createTestDoc(text: string) {
    const editor = new Editor({
      extensions: [StarterKit],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text }],
          },
        ],
      },
    });
    return editor.state.doc;
  }

  it("matches selection-scoped prompt intents accurately", () => {
    expect(matchAction("tighten this paragraph")).toBe("tighten");
    expect(matchAction("make the tone firmer")).toBe("firmer");
    expect(matchAction("turn this into a bulleted list")).toBe("bullet_list");
    expect(matchAction("fix grammar & typos")).toBe("proofread");
  });

  it("anchors 'firmer tone' rewrite to selection range and produces step trace", () => {
    const text = "We might want to consider deploying the worker next week if things look ok.";
    const doc = createTestDoc(text);

    // Range spanning the sentence (pos 1 to 1 + text.length)
    const scope: AssistScope = { from: 1, to: 1 + text.length };
    const plan = planAction("firmer", doc, scope);

    // 1. Verify step trace
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(plan.steps[0]).toContain("Read the selection");
    expect(plan.steps[1]).toContain("passive constructions");
    expect(plan.steps[2]).toContain("anchored to range");

    // 2. Verify edit is anchored to selection range
    expect(plan.edits.length).toBe(1);
    const edit = plan.edits[0];
    expect(edit.kind).toBe("replace");
    const replaceEdit = edit as Extract<typeof edit, { kind: "replace" }>;
    expect(replaceEdit.at).toBe(scope.from);
    expect(replaceEdit.find).toBe(text);
    expect(replaceEdit.text).toContain("we will");
    expect(replaceEdit.text).not.toContain("we might want to");

    // 3. Verify summary
    expect(plan.summary.title).toBe("Tone made firmer");
  });

  it("anchors 'bulleted list' conversion to selection range and produces step trace", () => {
    const text = "First verify database migrations. Then execute the worker deployment.";
    const doc = createTestDoc(text);

    const scope: AssistScope = { from: 1, to: 1 + text.length };
    const plan = planAction("bullet_list", doc, scope);

    // 1. Verify step trace
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(plan.steps[0]).toContain("Read the selection");
    expect(plan.steps[2]).toContain("anchored to selection");

    // 2. Verify edit is anchored to selection range
    expect(plan.edits.length).toBe(1);
    const edit = plan.edits[0];
    expect(edit.kind).toBe("replace");
    const replaceEdit = edit as Extract<typeof edit, { kind: "replace" }>;
    expect(replaceEdit.at).toBe(scope.from);
    expect(replaceEdit.find).toBe(text);
    expect(replaceEdit.text).toContain("• First verify database migrations.");
    expect(replaceEdit.text).toContain("• Then execute the worker deployment.");

    // 3. Verify summary
    expect(plan.summary.title).toBe("Converted to bulleted list");
  });

  it("anchors arbitrary selected text tighten action to selection range", () => {
    const text = "Due to the fact that our team has identified latency issues, we should optimize.";
    const doc = createTestDoc(text);

    const scope: AssistScope = { from: 1, to: 1 + text.length };
    const plan = planAction("tighten", doc, scope);

    // 1. Verify edit anchored to scope.from
    expect(plan.edits.length).toBe(1);
    const edit = plan.edits[0];
    expect(edit.kind).toBe("replace");
    const replaceEdit = edit as Extract<typeof edit, { kind: "replace" }>;
    expect(replaceEdit.at).toBe(scope.from);
    expect(replaceEdit.find).toBe(text);
    expect(replaceEdit.text).not.toContain("Due to the fact that");
  });

  it("backend endpoint /api/document-assistant/act handles selection-scoped actions with step trace and anchored edits", async () => {
    const mockEnv = {
      AI_GATEWAY_TOKEN: "mock-token",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "mock-cf-token",
    };

    const payload = {
      prompt: "Make the tone firmer",
      documentText: "Introduction\nWe might want to consider deploying the worker next week.",
      selectedText: "We might want to consider deploying the worker next week.",
      scope: { from: 13, to: 69 },
    };

    const res = await documentAssistantRouter.request(
      "/act",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      mockEnv,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    // Verify response structure
    expect(data.trace).toBeInstanceOf(Array);
    expect(data.trace.length).toBeGreaterThan(0);
    expect(data.suggestions).toBeInstanceOf(Array);
    expect(data.suggestions.length).toBe(1);

    const edit = data.suggestions[0];
    expect(edit.kind).toBe("replace");
    expect(edit.at).toBe(13); // Anchored to selection scope.from
    expect(edit.find).toBe(payload.selectedText);
    expect(edit.text).toContain("we will");

    // Verify Phase 5 wire-point header
    expect(res.headers.get("x-wire-point-phase5")).toContain("Task 67656680f6e8");
  });
});
