import { describe, expect, it } from "vitest";

import reference from "@/backend/docs/__fixtures__/reference-resume.structure.json";
import { findAll } from "@/backend/docs/find";
import { flattenTabs } from "@/backend/docs/locate";
import { outlineDoc, outlineLines } from "@/backend/docs/outline";

/** Rebuild a minimal documents.get body from the reference structure fixture. */
function toRawContent(items: any[]): any[] {
  return items.map((el) => {
    if ("p" in el) {
      return {
        startIndex: el.p,
        endIndex: el.end,
        paragraph: {
          elements: [{ startIndex: el.p, endIndex: el.end, textRun: { content: el.text, textStyle: {} } }],
          paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          ...(el.bullet ? { bullet: { listId: "kix.1" } } : {}),
        },
      };
    }
    return {
      startIndex: el.table,
      endIndex: el.end,
      table: {
        rows: el.rows,
        columns: el.columns,
        tableRows: el.cells.map((row: any[]) => ({
          tableCells: row.map((cell) => ({ startIndex: cell.start, endIndex: cell.end, content: toRawContent(cell.content) })),
        })),
      },
    };
  });
}

const referenceDoc = {
  revisionId: "rev-ref",
  tabs: [
    {
      tabProperties: { tabId: "t.0", title: "Tab 1" },
      documentTab: { body: { content: [{ endIndex: 1, sectionBreak: {} }, ...toRawContent(reference.body as any[])] } },
    },
  ],
};

const para = (start: number, runs: any[], extra: Record<string, unknown> = {}) => {
  let i = start;
  const elements = runs.map((r) => {
    const content = r.content;
    const el = { startIndex: i, endIndex: i + content.length, textRun: { content, textStyle: r.textStyle ?? {}, ...r.extra } };
    i += content.length;
    return el;
  });
  return { startIndex: start, endIndex: i, paragraph: { elements, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, ...extra } };
};

/** Two top-level tabs; the first has a nested child tab. A pending suggestion lives in t.0. */
const tabbedDoc = {
  revisionId: "rev-tabs",
  tabs: [
    {
      tabProperties: { tabId: "t.0", title: "Main" },
      documentTab: {
        body: {
          content: [
            { endIndex: 1, sectionBreak: {} },
            {
              ...para(1, [{ content: "Plan\n" }]),
              paragraph: { ...para(1, [{ content: "Plan\n" }]).paragraph, paragraphStyle: { namedStyleType: "HEADING_1" } },
            },
            para(6, [
              { content: "Ship the " },
              { content: "draft", extra: { suggestedInsertionIds: ["s1"] } },
              { content: " and the old", extra: { suggestedDeletionIds: ["s2"] } },
              { content: " plan.\n" },
            ]),
            para(39, [{ content: "Plan " }, { content: "B", textStyle: { bold: true } }, { content: " is bold plan\n" }]),
          ],
        },
      },
      childTabs: [
        {
          tabProperties: { tabId: "t.0.1", title: "Child", parentTabId: "t.0", nestingLevel: 1 },
          documentTab: { body: { content: [{ endIndex: 1, sectionBreak: {} }, para(1, [{ content: "child plan\n" }])] } },
        },
      ],
    },
    {
      tabProperties: { tabId: "t.1", title: "Second" },
      documentTab: { body: { content: [{ endIndex: 1, sectionBreak: {} }, para(1, [{ content: "no match here\n" }])] } },
    },
  ],
};

describe("flattenTabs order", () => {
  it("lists each parent before its children, depth-first", () => {
    expect(flattenTabs(tabbedDoc).map((t) => t.tabProperties.tabId)).toEqual(["t.0", "t.0.1", "t.1"]);
  });
});

describe("outlineDoc (B1)", () => {
  it("lists the reference resume's 3 tables and every cell paragraph with its range", () => {
    const { tabs } = outlineDoc(referenceDoc);
    const items = tabs[0].items;
    const tables = items.filter((i) => i.kind === "table");
    expect(tables.map((t) => [t.start, t.end, t.rows, t.columns])).toEqual([
      [2, 153, 1, 1],
      [154, 273, 1, 3],
      [274, 2386, 1, 2],
    ]);
    const cellParas = items.filter((i) => i.kind === "paragraph" && i.cell);
    const expected = (reference.body as any[])
      .filter((el) => "table" in el)
      .flatMap((t) => t.cells.flat().flatMap((c: any) => c.content.map((p: any) => [p.p, p.end])));
    expect(cellParas.map((p) => [p.start, p.end])).toEqual(expected);
    expect(cellParas[0]).toMatchObject({ table: 0, cell: [0, 0], text: "YOUR NAME", tabId: "t.0" });
    expect(items.find((i) => i.start === 1131)).toMatchObject({ bullet: true, table: 2, cell: [0, 1] });
    expect(tabs[0].endIndex).toBe(2387);
  });

  it("outlines nested tabs and marks pending suggestions", () => {
    const { tabs } = outlineDoc(tabbedDoc);
    expect(tabs.map((t) => t.tabId)).toEqual(["t.0", "t.0.1", "t.1"]);
    const p = tabs[0].items.find((i) => i.start === 6)!;
    expect(p.text).toBe("Ship the [+draft][- and the old] plan.");
    expect(p.suggestions).toBe(true);
    expect(tabs[0].items.find((i) => i.start === 1)!.style).toBe("HEADING_1");
    expect(tabs[1]).toMatchObject({ tabId: "t.0.1", endIndex: 12 });
  });

  it("limits to one tab and truncates long previews to 60 characters", () => {
    const { tabs } = outlineDoc(referenceDoc, { tabId: "t.0" });
    const long = tabs[0].items.find((i) => i.start === 778)!;
    expect(long.text!.length).toBe(60);
    expect(long.text!.endsWith("…")).toBe(true);
    expect(() => outlineDoc(referenceDoc, { tabId: "t.9" })).toThrow(/Tab not found: t\.9/);
  });

  it("renders one compact line per element and ends with the body end index", () => {
    const lines = outlineLines(outlineDoc(tabbedDoc, { tabId: "t.0" }));
    expect(lines[0]).toBe("# tab t.0 \"Main\"");
    expect(lines).toContain('P 1-6 HEADING_1 "Plan"');
    expect(lines.at(-1)).toBe("END t.0 59");
  });
});

describe("findAll (B2)", () => {
  it("returns every match, across tabs, with ranges", () => {
    const hits = findAll(tabbedDoc, "plan", { matchCase: true });
    expect(hits.map((h) => [h.tabId, h.startIndex, h.endIndex])).toEqual([
      ["t.0", 33, 37],
      ["t.0", 54, 58],
      ["t.0.1", 7, 11],
    ]);
  });

  it("matches case-insensitively when asked", () => {
    expect(findAll(tabbedDoc, "plan", { matchCase: false }).length).toBe(5);
  });

  it("flags a match inside a pending suggestion", () => {
    const [hit] = findAll(tabbedDoc, "the draft");
    expect(hit).toMatchObject({ startIndex: 11, endIndex: 20, inSuggestion: true });
    const [plain] = findAll(tabbedDoc, "Ship");
    expect(plain.inSuggestion).toBe(false);
  });

  it("reports bold as true, false or mixed", () => {
    expect(findAll(tabbedDoc, "B", { tabId: "t.0" })[0].bold).toBe(true);
    expect(findAll(tabbedDoc, "Plan B")[0].bold).toBe("mixed");
    expect(findAll(tabbedDoc, "Ship")[0].bold).toBe(false);
  });

  it("does not match across a non-text element", () => {
    const doc = {
      tabs: [
        {
          tabProperties: { tabId: "t.0" },
          documentTab: {
            body: {
              content: [
                {
                  startIndex: 1,
                  endIndex: 12,
                  paragraph: {
                    elements: [
                      { startIndex: 1, endIndex: 5, textRun: { content: "abcd", textStyle: {} } },
                      { startIndex: 5, endIndex: 6, footnoteReference: { footnoteId: "f" } },
                      { startIndex: 6, endIndex: 12, textRun: { content: "efgh.\n", textStyle: {} } },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    };
    expect(findAll(doc, "de")).toEqual([]);
    expect(findAll(doc, "ef")[0]).toMatchObject({ startIndex: 6, endIndex: 8 });
  });

  it("reports the table and cell of a match in a cell", () => {
    const [hit] = findAll(referenceDoc, "2M+");
    expect(hit).toMatchObject({ startIndex: 204, endIndex: 207, table: 1, cell: [0, 1] });
  });
});
