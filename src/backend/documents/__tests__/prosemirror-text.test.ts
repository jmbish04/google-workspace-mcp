/**
 * @fileoverview Unit tests for the pure Tiptap/ProseMirror text helpers.
 *
 * Each case is written to FAIL if the behaviour it covers is removed: structured
 * extraction, single-run editing, occurrence targeting, block scoping, and the
 * deliberate refusal to edit across styled runs.
 */
import { describe, expect, it } from "vitest";

import {
  applyTextChange,
  extractBlocks,
  extractPlainText,
  type PMNode,
} from "@/backend/documents/prosemirror-text";

const doc: PMNode = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "The quick brown fox. " },
        { type: "text", text: "quick", marks: [{ type: "bold" }] },
      ],
    },
    { type: "paragraph", content: [{ type: "text", text: "A second quick line." }] },
  ],
};

describe("extractBlocks / extractPlainText", () => {
  it("flattens top-level blocks with type, text, and heading level", () => {
    const blocks = extractBlocks(doc);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ index: 0, type: "heading", text: "Title", level: 1 });
    expect(blocks[1]).toMatchObject({ index: 1, type: "paragraph", text: "The quick brown fox. quick" });
    expect(blocks[2]!.level).toBeUndefined();
  });

  it("joins block text with newlines", () => {
    expect(extractPlainText(doc)).toBe("Title\nThe quick brown fox. quick\nA second quick line.");
  });

  it("throws on non-object content", () => {
    expect(() => extractBlocks(null)).toThrow(/ProseMirror/);
  });
});

describe("applyTextChange", () => {
  it("replaces the first single-run occurrence without mutating the input", () => {
    const res = applyTextChange(doc, { find: "quick" }, { kind: "replace", text: "slow" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.before).toBe("quick");
    expect(res.after).toBe("slow");
    // First single-run "quick" is in block 1's first run.
    expect(extractBlocks(res.content)[1]!.text).toBe("The slow brown fox. quick");
    // Input untouched (deep clone).
    expect(extractBlocks(doc)[1]!.text).toBe("The quick brown fox. quick");
  });

  it("targets the Nth single-run occurrence", () => {
    // Occurrences within a single run, counted in document order:
    // 1) block1 run0 "quick"  2) block1 run1 (bold) "quick"  3) block2 "quick"
    const res = applyTextChange(doc, { find: "quick", occurrence: 3 }, { kind: "replace", text: "fast" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(extractBlocks(res.content)[2]!.text).toBe("A second fast line.");
    // Earlier occurrences untouched.
    expect(extractBlocks(res.content)[1]!.text).toBe("The quick brown fox. quick");
  });

  it("scopes the search to a block index", () => {
    const res = applyTextChange(
      doc,
      { find: "quick", blockIndex: 2 },
      { kind: "replace", text: "swift" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(extractBlocks(res.content)[2]!.text).toBe("A second swift line.");
    expect(extractBlocks(res.content)[1]!.text).toBe("The quick brown fox. quick");
  });

  it("inserts before and after a match", () => {
    const before = applyTextChange(doc, { find: "fox" }, { kind: "insert_before", text: "red " });
    expect(before.ok && extractBlocks(before.content)[1]!.text).toContain("brown red fox");
    const after = applyTextChange(doc, { find: "Title" }, { kind: "insert_after", text: " Page" });
    expect(after.ok && extractBlocks(after.content)[0]!.text).toBe("Title Page");
  });

  it("deletes a match", () => {
    const res = applyTextChange(doc, { find: "brown " }, { kind: "delete" });
    expect(res.ok && extractBlocks(res.content)[1]!.text).toBe("The quick fox. quick");
  });

  it("reports notFound for text that is not present", () => {
    const res = applyTextChange(doc, { find: "elephant" }, { kind: "delete" });
    expect(res).toEqual({ ok: false, reason: "notFound", matches: 0 });
  });

  it("refuses a match that spans two styled runs instead of rewriting mixed styling", () => {
    // "fox. quick" straddles the plain run and the bold run — present in the
    // document text, but not within any single run.
    const res = applyTextChange(doc, { find: "fox. quick" }, { kind: "replace", text: "x" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("spansMultipleNodes");
    expect(res.matches).toBe(1);
  });

  it("reports notFound when the occurrence index exceeds the match count", () => {
    const res = applyTextChange(doc, { find: "Title", occurrence: 2 }, { kind: "delete" });
    expect(res).toEqual({ ok: false, reason: "notFound", matches: 1 });
  });
});
