/**
 * @fileoverview Tests for the notes body serialization layer
 * (`components/notes/notes-value.ts`) — the compatibility contract of the
 * Tiptap migration (docs/decisions/2026-10-04-platejs-vs-tiptap.md).
 *
 * The load-bearing guarantees under test:
 *   1. An OLD Plate `{v:1,format:"plate"}` envelope still LOADS, degrading to
 *      plain text (the words survive; the Plate structure does not). Removing
 *      that fallback must fail these tests.
 *   2. New saves round-trip: body → doc → body is lossless.
 *   3. Legacy plain-text and empty/garbage bodies never crash the loader.
 *   4. `tiptapDocToBody("")` stores "" so the API's "body required"
 *      validation keeps working.
 */
import { describe, expect, it } from "vitest";

import type { TiptapDoc } from "@/shared/tiptap-email";

import {
  bodyToSnippet,
  bodyToTiptapDoc,
  emptyTiptapDoc,
  plainTextToTiptapDoc,
  plateValueToPlainText,
  tiptapDocToBody,
  tiptapDocToPlainText,
} from "../notes-value";

/** A realistic stored Plate envelope, as authored by the old editor. */
const PLATE_ENVELOPE = JSON.stringify({
  v: 1,
  format: "plate",
  value: [
    {
      type: "h1",
      children: [{ text: "Sprint plan" }],
    },
    {
      type: "p",
      children: [{ text: "Ship ", bold: true }, { text: "the release notes." }],
    },
    {
      type: "p",
      listStyleType: "disc",
      indent: 1,
      children: [{ text: "Item one" }],
    },
  ],
});

describe("bodyToTiptapDoc — v2 Tiptap envelope", () => {
  it("returns the stored document as-is", () => {
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Head" }] },
      ],
    };
    const body = JSON.stringify({ v: 2, format: "tiptap", value: doc });
    expect(bodyToTiptapDoc(body)).toEqual(doc);
  });

  it("round-trips: body → doc → body is lossless", () => {
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }],
            },
          ],
        },
      ],
    };
    const body = tiptapDocToBody(doc);
    expect(body).toBe(JSON.stringify({ v: 2, format: "tiptap", value: doc }));
    expect(bodyToTiptapDoc(body)).toEqual(doc);
  });

  it("rejects a body with the right shape but wrong version", () => {
    // A future/hand-edited envelope must not be mistaken for v2 — it falls
    // back to plain text so the raw JSON never renders as a document.
    const fake = JSON.stringify({ v: 3, format: "tiptap", value: { type: "doc", content: [] } });
    const doc = bodyToTiptapDoc(fake);
    expect(doc.type).toBe("doc");
    expect(tiptapDocToPlainText(doc)).toContain('"v":3');
  });
});

describe("bodyToTiptapDoc — legacy Plate envelope (plain-text fallback)", () => {
  it("loads an old {v:1,format:'plate'} envelope without crashing", () => {
    const doc = bodyToTiptapDoc(PLATE_ENVELOPE);
    expect(doc.type).toBe("doc");
    expect(Array.isArray(doc.content)).toBe(true);
    expect(doc.content!.length).toBeGreaterThan(0);
  });

  it("degrades the Plate content to plain text, preserving every word", () => {
    const text = tiptapDocToPlainText(bodyToTiptapDoc(PLATE_ENVELOPE));
    expect(text).toContain("Sprint plan");
    expect(text).toContain("Ship the release notes.");
    expect(text).toContain("Item one");
    // Blocks are joined with newlines, not run together.
    expect(text.split("\n").length).toBe(3);
  });

  it("does NOT translate Plate structure into Tiptap structure", () => {
    // The fallback is deliberately one-way: the heading stays a paragraph
    // (text only). If someone "upgrades" the fallback into a structure
    // translator, that is a different contract — this pins the plain-text one.
    const doc = bodyToTiptapDoc(PLATE_ENVELOPE);
    for (const block of doc.content!) {
      expect(block.type).toBe("paragraph");
    }
  });

  it("an empty-value Plate envelope never crashes", () => {
    const empty = JSON.stringify({ v: 1, format: "plate", value: [] });
    const doc = bodyToTiptapDoc(empty);
    expect(doc).toEqual(emptyTiptapDoc());
  });
});

describe("bodyToTiptapDoc — legacy plain text and garbage", () => {
  it("lifts plain text into one paragraph per line", () => {
    const doc = bodyToTiptapDoc("line one\nline two");
    expect(doc.content).toHaveLength(2);
    expect(tiptapDocToPlainText(doc)).toBe("line one\nline two");
  });

  it("treats malformed JSON starting with { as plain text, keeping the words", () => {
    const doc = bodyToTiptapDoc("{not json at all, but words survive");
    expect(tiptapDocToPlainText(doc)).toBe("{not json at all, but words survive");
  });

  it("returns an empty document for empty / blank input", () => {
    expect(bodyToTiptapDoc("")).toEqual(emptyTiptapDoc());
    expect(bodyToTiptapDoc("   ")).toEqual(emptyTiptapDoc());
    expect(bodyToTiptapDoc(null)).toEqual(emptyTiptapDoc());
  });
});

describe("tiptapDocToBody", () => {
  it("stores an empty string for an empty / whitespace-only document", () => {
    // The API rejects a blank body with 400; the editor must therefore emit
    // "" when the human cleared the text.
    expect(tiptapDocToBody(emptyTiptapDoc())).toBe("");
    expect(
      tiptapDocToBody({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "   " }] }],
      }),
    ).toBe("");
    expect(tiptapDocToBody(null)).toBe("");
  });

  it("always emits the v2 tiptap envelope shape", () => {
    const body = tiptapDocToBody(plainTextToTiptapDoc("saved"));
    const parsed = JSON.parse(body);
    expect(parsed.v).toBe(2);
    expect(parsed.format).toBe("tiptap");
    expect(parsed.value.type).toBe("doc");
  });
});

describe("bodyToSnippet", () => {
  it("extracts text from every storage form", () => {
    expect(bodyToSnippet(PLATE_ENVELOPE)).toContain("Sprint plan");
    expect(bodyToSnippet("plain note")).toBe("plain note");
    expect(bodyToSnippet(tiptapDocToBody(plainTextToTiptapDoc("rich")))).toBe("rich");
  });

  it("returns '' for a blank body so 'body required' validation works", () => {
    expect(bodyToSnippet("")).toBe("");
    expect(bodyToSnippet(tiptapDocToBody(emptyTiptapDoc()))).toBe("");
  });
});

describe("plateValueToPlainText", () => {
  it("flattens nested Slate nodes without marks leaking in", () => {
    expect(
      plateValueToPlainText([
        { type: "p", children: [{ text: "a" }, { text: "b", bold: true }] },
        { type: "p", children: [{ text: "c" }] },
      ]),
    ).toBe("ab\nc");
  });

  it("tolerates junk without throwing", () => {
    expect(plateValueToPlainText("nope")).toBe("");
    expect(plateValueToPlainText([{ children: null }])).toBe("");
    expect(plateValueToPlainText(null)).toBe("");
  });
});
