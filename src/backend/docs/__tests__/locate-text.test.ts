import { describe, it, expect } from "vitest";

import { locateText } from "@/backend/docs/locate";

/** A paragraph whose runs start at `start` with contiguous UTF-16 indices. */
function para(start: number, runs: [string, Record<string, unknown>?][]) {
  let i = start;
  return {
    paragraph: {
      elements: runs.map(([content, textStyle]) => {
        const el = { startIndex: i, endIndex: i + content.length, textRun: { content, textStyle: textStyle ?? {} } };
        i += content.length;
        return el;
      }),
    },
  };
}

// "Status: the draft is " [1,22) · "ready for review" (bold) [22,38) · " today.\n" [38,46)
const doc = {
  body: { content: [para(1, [["Status: the draft is "], ["ready for review", { bold: true }], [" today.\n"]])] },
};

describe("locateText", () => {
  it("resolves a single-run match to its range and style", () => {
    const hit = locateText(doc, "ready for review")!;
    expect(hit.startIndex).toBe(22);
    expect(hit.endIndex).toBe(38);
    expect(hit.runs).toEqual([{ startIndex: 22, endIndex: 38, content: "ready for review", textStyle: { bold: true } }]);
  });

  it("returns every covered run slice for a match spanning styles", () => {
    const hit = locateText(doc, "is ready")!;
    expect(hit.startIndex).toBe(19);
    expect(hit.endIndex).toBe(27);
    expect(hit.runs.map((r) => [r.content, r.textStyle])).toEqual([
      ["is ", {}],
      ["ready", { bold: true }],
    ]);
  });

  it("picks the nth instance", () => {
    const d = { body: { content: [para(1, [["a b a\n"]])] } };
    expect(locateText(d, "a", 2)!.startIndex).toBe(5);
    expect(locateText(d, "a", 3)).toBeNull();
  });

  it("is case-sensitive by default; matchCase:false ignores case", () => {
    expect(locateText(doc, "READY FOR REVIEW")).toBeNull();
    expect(locateText(doc, "READY FOR REVIEW", 1, { matchCase: false })!.startIndex).toBe(22);
  });

  it("counts UTF-16 code units (emoji = 2)", () => {
    const d = { body: { content: [para(1, [["😀 hello\n"]])] } };
    expect(locateText(d, "hello")!.startIndex).toBe(4);
  });

  it("reads the requested tab (includeTabsContent shape), first tab by default", () => {
    const d = {
      tabs: [
        { tabProperties: { tabId: "t.0" }, documentTab: { body: { content: [para(1, [["first\n"]])] } } },
        { tabProperties: { tabId: "t.1" }, documentTab: { body: { content: [para(1, [["second\n"]])] } } },
      ],
    };
    expect(locateText(d, "second")).toBeNull();
    expect(locateText(d, "second", 1, { tabId: "t.1" })!.startIndex).toBe(1);
  });

  it("finds text inside table cells", () => {
    const d = { body: { content: [{ table: { tableRows: [{ tableCells: [{ content: [para(5, [["cell text\n"]])] }] }] } }] } };
    expect(locateText(d, "text")!.startIndex).toBe(10);
  });

  it("returns null when absent or find is empty", () => {
    expect(locateText(doc, "missing")).toBeNull();
    expect(locateText(doc, "")).toBeNull();
  });

  it("reads a nested child tab by id (docs_list_tabs flattens childTabs, so its ids must resolve)", () => {
    const d = {
      tabs: [
        {
          tabProperties: { tabId: "t.0" },
          documentTab: { body: { content: [para(1, [["parent tab\n"]])] } },
          childTabs: [
            {
              tabProperties: { tabId: "t.0.1" },
              documentTab: { body: { content: [para(1, [["child tab text\n"]])] } },
            },
          ],
        },
      ],
    };
    expect(locateText(d, "child tab text")).toBeNull(); // not in the default (first top-level) tab
    expect(locateText(d, "child tab text", 1, { tabId: "t.0.1" })!.startIndex).toBe(1);
  });

  it("flags runs carrying tracked-change suggestions, and leaves clean runs unflagged", () => {
    const suggested = (extra: Record<string, unknown>) => ({
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { startIndex: 1, endIndex: 6, textRun: { content: "clean", textStyle: {} } },
                { startIndex: 6, endIndex: 15, textRun: { content: " proposed", textStyle: {}, ...extra } },
              ],
            },
          },
        ],
      },
    });
    for (const extra of [
      { suggestedInsertionIds: ["sug.1"] },
      { suggestedDeletionIds: ["sug.2"] },
      { suggestedTextStyleChanges: { "sug.3": {} } },
    ]) {
      const d = suggested(extra);
      expect(locateText(d, "clean")!.runs[0].hasSuggestions).toBeUndefined();
      expect(locateText(d, "proposed")!.runs[0].hasSuggestions).toBe(true);
    }
  });

  it("matchCase:false never throws — a length-changing lower-case char (İ, ß) elsewhere still resolves correct indices", () => {
    // "İstanbul draft is " [1,19) · "READY" (bold) [19,24) · " İ ß\n" [24,29)
    const d = {
      body: {
        content: [
          para(1, [["İstanbul draft is "], ["READY", { bold: true }], [" İ ß\n"]]),
        ],
      },
    };
    expect(() => locateText(d, "ready", 1, { matchCase: false })).not.toThrow();
    const hit = locateText(d, "ready", 1, { matchCase: false })!;
    expect(hit.startIndex).toBe(19);
    expect(hit.endIndex).toBe(24);
    expect(hit.runs).toEqual([{ startIndex: 19, endIndex: 24, content: "READY", textStyle: { bold: true } }]);
  });
});
