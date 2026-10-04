/**
 * @fileoverview Tests for the task rich-text storage readers
 * (`components/tasks/task-html.ts`) — the legacy-compatibility contract of the
 * Tiptap migration (docs/decisions/2026-10-04-platejs-vs-tiptap.md).
 *
 * Task descriptions and comments store HTML; older rows may hold a Round-2
 * Plate envelope or plain text. The load-bearing guarantees under test:
 *   1. An old Plate envelope still flattens to plain text and renders —
 *      removing the fallback must fail these tests.
 *   2. HTML fragments pass through `normalizeStoredToHtml` untouched.
 *   3. `htmlToPlainText` never returns markup, for any storage form.
 *   4. The editor's write path (Tiptap → `tiptapToHtml`) emits the clean
 *      semantic HTML the renderer expects.
 */
import { describe, expect, it } from "vitest";

import { tiptapToHtml, type TiptapDoc } from "@/shared/tiptap-email";

import { sanitizeHtml } from "../sanitize-html";
import { htmlToPlainText, normalizeStoredToHtml, plateEnvelopeToPlainText } from "../task-html";

/** A realistic stored Plate envelope, as authored by the old editor. */
const PLATE_ENVELOPE = JSON.stringify({
  v: 1,
  format: "plate",
  value: [
    { type: "h2", children: [{ text: "Acceptance criteria" }] },
    {
      type: "p",
      children: [{ text: "Must ", bold: true }, { text: "pass CI." }],
    },
  ],
});

describe("plateEnvelopeToPlainText (the legacy Plate reader)", () => {
  it("flattens a stored Plate envelope to plain text", () => {
    const text = plateEnvelopeToPlainText(PLATE_ENVELOPE);
    expect(text).toBe("Acceptance criteria\nMust pass CI.");
  });

  it("returns null for anything that is not a Plate envelope", () => {
    expect(plateEnvelopeToPlainText("<p>html</p>")).toBeNull();
    expect(plateEnvelopeToPlainText("plain text")).toBeNull();
    expect(plateEnvelopeToPlainText("")).toBeNull();
    expect(plateEnvelopeToPlainText(null)).toBeNull();
    expect(plateEnvelopeToPlainText('{"format":"tiptap"}')).toBeNull();
  });

  it("never throws on malformed JSON", () => {
    expect(plateEnvelopeToPlainText("{oops")).toBeNull();
  });
});

describe("normalizeStoredToHtml", () => {
  it("uses an HTML fragment verbatim", () => {
    const html = "<p>a <strong>b</strong></p><ul><li>c</li></ul>";
    expect(normalizeStoredToHtml(html)).toBe(html);
  });

  it("upgrades an old Plate envelope to paragraph HTML via the plain-text fallback", () => {
    const html = normalizeStoredToHtml(PLATE_ENVELOPE);
    // Blocks are joined with single newlines, which the pre-existing
    // plain-text path renders as <br> within one paragraph — same shape a
    // legacy plain-text description of this note would produce.
    expect(html).toBe("<p>Acceptance criteria<br>Must pass CI.</p>");
    // No Plate structure (headings/marks) survives — text only, by design.
    expect(html).not.toMatch(/<h[1-6]|<strong|data-slate/);
  });

  it("lifts plain text into paragraphs, single newlines into <br>", () => {
    expect(normalizeStoredToHtml("one\n\ntwo\nthree")).toBe("<p>one</p><p>two<br>three</p>");
  });

  it("escapes plain text so it cannot inject markup", () => {
    expect(normalizeStoredToHtml("<script>alert(1)</script> and text")).toContain("&lt;script&gt;");
    expect(normalizeStoredToHtml("<script>alert(1)</script> and text")).not.toMatch(
      /<script>alert/,
    );
  });

  it("returns '' for empty input", () => {
    expect(normalizeStoredToHtml("")).toBe("");
    expect(normalizeStoredToHtml(null)).toBe("");
  });
});

describe("htmlToPlainText", () => {
  it("flattens every storage form and never returns markup", () => {
    expect(htmlToPlainText(PLATE_ENVELOPE)).toBe("Acceptance criteria\nMust pass CI.");
    expect(htmlToPlainText("<p>a</p><ul><li>b</li></ul>")).toBe("a\nb");
    expect(htmlToPlainText("plain")).toBe("plain");
    for (const stored of [PLATE_ENVELOPE, "<p><strong>x</strong></p>", "plain"]) {
      expect(htmlToPlainText(stored)).not.toMatch(/<[^>]+>/);
    }
  });

  it("returns '' for empty input so 'is this empty?' checks work", () => {
    expect(htmlToPlainText("")).toBe("");
    expect(htmlToPlainText("<p></p>")).toBe("");
    expect(htmlToPlainText(null)).toBe("");
  });
});

describe("the Tiptap editor write path (doc → stored HTML)", () => {
  it("serializes a document the way TaskRichEditor emits it on change", () => {
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Ship " },
            { type: "text", text: "it", marks: [{ type: "bold" }] },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
            },
          ],
        },
      ],
    };
    expect(tiptapToHtml(doc)).toBe("<p>Ship <strong>it</strong></p><ul><li>one</li></ul>");
  });

  it("drops editor chrome (highlight/align/task lists) so none reaches the stored column", () => {
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { textAlign: "center" },
          content: [
            {
              type: "text",
              text: "hi",
              marks: [{ type: "highlight", attrs: { color: "yellow" } }],
            },
          ],
        },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "todo" }] }],
            },
          ],
        },
      ],
    };
    const html = tiptapToHtml(doc);
    expect(html).toBe("<p>hi</p><ul><li>todo</li></ul>");
    expect(html).not.toMatch(/style=|class=|data-|text-align|checkbox/i);
  });

  it("the emitted HTML survives the wire sanitizer unchanged", () => {
    const html = tiptapToHtml({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "link ",
              marks: [{ type: "link", attrs: { href: "https://x.y" } }],
            },
            { type: "text", text: "and ", marks: [{ type: "code" }] },
          ],
        },
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "H" }] },
        { type: "codeBlock", content: [{ type: "text", text: "let x = 1;" }] },
      ],
    });
    expect(sanitizeHtml(html)).toBe(html);
  });

  it("an empty document emits '<p></p>' — flattened to empty by the host checks", () => {
    // Matches the old Plate path's output for an emptied document. Hosts
    // treat it as empty via htmlToPlainText("<p></p>") === "" (TaskComments)
    // and htmlToPlainText(...).trim() (TaskDetail), which is what keeps the
    // "no description" / disabled-send empty states working.
    expect(tiptapToHtml({ type: "doc", content: [{ type: "paragraph" }] })).toBe("<p></p>");
    expect(htmlToPlainText("<p></p>")).toBe("");
  });
});
