import { describe, it, expect } from "vitest";

import { planTextEdit } from "@/backend/docs/edit-text";
import { locateText } from "@/backend/docs/locate";
import type { LocatedText } from "@/backend/docs/locate";

const bold = { bold: true };
const single: LocatedText = {
  startIndex: 22,
  endIndex: 38,
  runs: [{ startIndex: 22, endIndex: 38, content: "ready for review", textStyle: bold }],
};

describe("planTextEdit", () => {
  it("inserts inside the match, then deletes the original chars — only insertText + deleteContentRange", () => {
    const plan = planTextEdit(single, "approved and final"); // 18 chars
    expect(plan).toEqual({
      ok: true,
      requests: [
        { insertText: { location: { index: 23 }, text: "approved and final" } },
        { deleteContentRange: { range: { startIndex: 41, endIndex: 56 } } },
        { deleteContentRange: { range: { startIndex: 22, endIndex: 23 } } },
      ],
    });
    if (!plan.ok) throw new Error("unreachable");
    for (const r of plan.requests) {
      expect(Object.keys(r)).toHaveLength(1);
      expect(["insertText", "deleteContentRange"]).toContain(Object.keys(r)[0]);
    }
  });

  it("carries tabId on every location and range", () => {
    const plan = planTextEdit(single, "ok", "t.1");
    expect(plan).toEqual({
      ok: true,
      requests: [
        { insertText: { location: { index: 23, tabId: "t.1" }, text: "ok" } },
        { deleteContentRange: { range: { startIndex: 25, endIndex: 40, tabId: "t.1" } } },
        { deleteContentRange: { range: { startIndex: 22, endIndex: 23, tabId: "t.1" } } },
      ],
    });
  });

  it("a one-character match needs no middle delete", () => {
    const hit: LocatedText = { startIndex: 5, endIndex: 6, runs: [{ startIndex: 5, endIndex: 6, content: "a", textStyle: {} }] };
    expect(planTextEdit(hit, "XY")).toEqual({
      ok: true,
      requests: [
        { insertText: { location: { index: 6 }, text: "XY" } },
        { deleteContentRange: { range: { startIndex: 5, endIndex: 6 } } },
      ],
    });
  });

  it("an empty replacement is a single delete", () => {
    expect(planTextEdit(single, "")).toEqual({
      ok: true,
      requests: [{ deleteContentRange: { range: { startIndex: 22, endIndex: 38 } } }],
    });
  });

  it("refuses a match spanning more than one text style and writes nothing", () => {
    const hit: LocatedText = {
      startIndex: 19,
      endIndex: 27,
      runs: [
        { startIndex: 19, endIndex: 22, content: "is ", textStyle: {} },
        { startIndex: 22, endIndex: 27, content: "ready", textStyle: bold },
      ],
    };
    expect(planTextEdit(hit, "was set")).toEqual({ ok: false, mixedStyles: true, runs: hit.runs });
  });

  it("throws when the match contains a paragraph break", () => {
    const hit: LocatedText = { startIndex: 1, endIndex: 4, runs: [{ startIndex: 1, endIndex: 4, content: "a\nb", textStyle: {} }] };
    expect(() => planTextEdit(hit, "c")).toThrow(/paragraph breaks/);
  });

  it("a tabId edit reads that tab's content, not the first tab (locateText + planTextEdit)", () => {
    const doc = {
      tabs: [
        {
          tabProperties: { tabId: "t.0" },
          documentTab: { body: { content: [{ paragraph: { elements: [{ startIndex: 1, endIndex: 12, textRun: { content: "first tab\n", textStyle: {} } }] } }] } },
        },
        {
          tabProperties: { tabId: "t.1" },
          documentTab: {
            body: {
              content: [
                { paragraph: { elements: [{ startIndex: 1, endIndex: 18, textRun: { content: "ready for review\n", textStyle: bold } }] } },
              ],
            },
          },
        },
      ],
    };
    // Not found in the default (first) tab.
    expect(locateText(doc, "ready for review")).toBeNull();
    const hit = locateText(doc, "ready for review", 1, { tabId: "t.1" });
    expect(hit).not.toBeNull();
    const plan = planTextEdit(hit!, "approved", "t.1");
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("unreachable");
    for (const r of plan.requests) {
      const loc = (r.insertText as { location?: { tabId?: string } } | undefined)?.location;
      const range = (r.deleteContentRange as { range?: { tabId?: string } } | undefined)?.range;
      expect((loc ?? range)?.tabId).toBe("t.1");
    }
  });
});
