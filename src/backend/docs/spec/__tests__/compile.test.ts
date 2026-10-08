import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import reference from "@/backend/docs/__fixtures__/reference-resume.structure.json";
import { compileSpec, type CompiledSpec } from "@/backend/docs/spec/compile";
import { resumeSpec } from "@/backend/docs/spec/golden/resume";
import { layoutSpecSchema } from "@/backend/docs/spec/schema";

const opts = { insertAt: 1, tabId: "t.0", trailing: "own" as const };
const types = (c: CompiledSpec) => c.requests.map((r) => Object.keys(r)[0]);

/** Every index a request names (locations, ranges, table starts). */
function indicesOf(req: any): number[] {
  const out: number[] = [];
  const walk = (v: any, key = "") => {
    if (!v || typeof v !== "object") return;
    if (["location", "range", "tableStartLocation"].includes(key)) {
      for (const k of ["index", "startIndex", "endIndex"]) if (typeof v[k] === "number") out.push(v[k]);
    }
    for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(req);
  return out;
}

describe("layout spec schema (C1)", () => {
  it("expresses the reference resume without raw requests", () => {
    const parsed = layoutSpecSchema.safeParse(resumeSpec);
    expect(parsed.success).toBe(true);
  });

  it("names the path of an unknown color token", () => {
    const bad = structuredClone(resumeSpec) as any;
    bad.blocks[2].rows[0].cells[1].blocks[1].color = "teal-ish";
    const res = layoutSpecSchema.safeParse(bad);
    expect(res.success).toBe(false);
    const issue = (res as { error: ZodError }).error.issues[0];
    expect(issue.path).toEqual(["blocks", 2, "rows", 0, "cells", 1, "blocks", 1, "color"]);
    expect(issue.message).toMatch(/Unknown color "teal-ish"/);
  });

  it("names the path of an unknown preset and of a run with a newline", () => {
    const res = layoutSpecSchema.safeParse({
      blocks: [{ type: "paragraph", style: "nope", runs: [{ text: "a\nb" }] }],
    });
    expect(res.success).toBe(false);
    const paths = (res as { error: ZodError }).error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("blocks.0.runs.0.text");
  });

  it("rejects a preset name that is not defined", () => {
    const res = layoutSpecSchema.safeParse({ blocks: [{ type: "paragraph", style: "nope", text: "x" }] });
    expect((res as { error: ZodError }).error.issues[0]).toMatchObject({ path: ["blocks", 0, "style"] });
  });
});

describe("compileSpec (C2)", () => {
  it("1 paragraph: insert without a final newline (it merges into the empty paragraph), then style", () => {
    const c = compileSpec({ blocks: [{ type: "paragraph", text: "Hello", bold: true }] }, opts);
    expect(types(c)).toEqual(["insertText", "updateParagraphStyle", "updateTextStyle"]);
    expect(c.requests[0]).toEqual({ insertText: { location: { index: 1, tabId: "t.0" }, text: "Hello" } });
    expect(c.layout.paragraphs).toEqual([{ start: 1, end: 7, text: "Hello" }]);
    const ts = (c.requests[2] as any).updateTextStyle;
    expect(ts.range).toEqual({ startIndex: 1, endIndex: 7, tabId: "t.0" });
    expect(ts.textStyle.bold).toBe(true);
    expect(c).toMatchSnapshot();
  });

  it("1 list: one createParagraphBullets over the items; list items keep the list indentation", () => {
    const c = compileSpec({ blocks: [{ type: "list", items: ["One", "Two"] }] }, opts);
    expect(c.requests[0]).toMatchObject({ insertText: { text: "One\nTwo" } });
    const bullets = c.requests.filter((r) => "createParagraphBullets" in r) as any[];
    expect(bullets).toEqual([
      { createParagraphBullets: { range: { startIndex: 1, endIndex: 9, tabId: "t.0" }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } },
    ]);
    const ps = (c.requests.find((r) => "updateParagraphStyle" in r) as any).updateParagraphStyle;
    expect(ps.fields).not.toContain("indentStart");
    expect(types(c).indexOf("createParagraphBullets")).toBeLessThan(types(c).indexOf("updateParagraphStyle"));
    expect(c).toMatchSnapshot();
  });

  it("1x1 table: gap paragraph, empty table, fill, trailing paragraph", () => {
    const c = compileSpec({ blocks: [{ type: "table", columns: 1, rows: [{ cells: [{ blocks: [{ type: "paragraph", text: "A" }] }] }] }] }, opts);
    expect(c.requests.slice(0, 2)).toEqual([
      { insertTable: { rows: 1, columns: 1, location: { index: 1, tabId: "t.0" } } },
      { insertText: { location: { index: 5, tabId: "t.0" }, text: "A" } },
    ]);
    expect(c.layout.tables).toEqual([{ start: 2, end: 8, rows: 1, columns: 1, cells: [[{ start: 4, end: 7 }]] }]);
    expect(c.layout.paragraphs.map((p) => [p.start, p.end, Boolean(p.gap)])).toEqual([
      [1, 2, true],
      [5, 7, false],
      [8, 9, true],
    ]);
    expect(c).toMatchSnapshot();
  });

  it("1x3 table: fills the last cell first at the measured empty indices", () => {
    const c = compileSpec(
      {
        blocks: [{ type: "table", columns: 3, rows: [{ cells: ["a", "bb", "ccc"].map((t) => ({ blocks: [{ type: "paragraph" as const, text: t }] })) }] }],
      },
      opts,
    );
    const fills = c.requests.filter((r) => "insertText" in r).map((r: any) => [r.insertText.location.index, r.insertText.text]);
    expect(fills).toEqual([
      [9, "ccc"],
      [7, "bb"],
      [5, "a"],
    ]);
    expect(c.layout.tables[0].cells[0].map((x) => x.start)).toEqual([4, 7, 11]);
    expect(c).toMatchSnapshot();
  });

  it("1x2 table with nested lists in a cell", () => {
    const c = compileSpec(
      {
        blocks: [
          {
            type: "table",
            columns: [{ width: 150 }, {}],
            cell: { borders: "none" },
            rows: [
              {
                cells: [
                  { blocks: [{ type: "heading", level: 3, text: "Left" }, { type: "list", items: ["x", "y"] }] },
                  { blocks: [{ type: "list", ordered: true, items: ["one", "two", "three"] }] },
                ],
              },
            ],
          },
        ],
      },
      opts,
    );
    const bullets = c.requests.filter((r) => "createParagraphBullets" in r) as any[];
    expect(bullets.map((b) => b.createParagraphBullets.bulletPreset)).toEqual(["BULLET_DISC_CIRCLE_SQUARE", "NUMBERED_DECIMAL_ALPHA_ROMAN"]);
    const cols = c.requests.filter((r) => "updateTableColumnProperties" in r) as any[];
    expect(cols.map((r) => r.updateTableColumnProperties.tableColumnProperties.widthType)).toEqual(["EVENLY_DISTRIBUTED", "FIXED_WIDTH"]);
    expect(c).toMatchSnapshot();
  });

  it("text before a table needs no gap paragraph; a table after a table does", () => {
    const c = compileSpec(
      {
        blocks: [
          { type: "paragraph", text: "Title" },
          { type: "table", columns: 1, rows: [{ cells: [{}] }] },
          { type: "table", columns: 1, rows: [{ cells: [{}] }], gapBefore: 4 },
          { type: "paragraph", text: "End" },
        ],
      },
      opts,
    );
    expect(c.requests[0]).toEqual({ insertText: { location: { index: 1, tabId: "t.0" }, text: "Title" } });
    expect(c.layout.paragraphs.map((p) => [p.start, p.end, p.text, Boolean(p.gap)])).toEqual([
      [1, 7, "Title", false],
      [10, 11, "", false],
      [12, 13, "", true],
      [16, 17, "", false],
      [18, 22, "End", false],
    ]);
    expect(c.layout.tables.map((t) => t.start)).toEqual([7, 13]);
  });

  it("never names pageBreakBefore for paragraphs in a table cell (Google refuses it)", () => {
    const c = compileSpec({ blocks: [{ type: "table", columns: 1, rows: [{ cells: [{ blocks: [{ type: "paragraph", text: "A" }] }] }] }] }, opts);
    const ps = c.requests.filter((r) => "updateParagraphStyle" in r).map((r: any) => r.updateParagraphStyle);
    const inCell = ps.find((p) => p.range.startIndex === 5)!;
    expect(inCell.fields).not.toContain("pageBreakBefore");
    expect(inCell.paragraphStyle).not.toHaveProperty("pageBreakBefore");
    const gap = ps.find((p) => p.range.startIndex === 1)!;
    expect(gap.fields).toContain("pageBreakBefore");
  });

  it("a pageBreak sets pageBreakBefore on the next paragraph", () => {
    const c = compileSpec({ blocks: [{ type: "paragraph", text: "A" }, { type: "pageBreak" }, { type: "paragraph", text: "B" }] }, opts);
    const ps = c.requests.filter((r) => "updateParagraphStyle" in r).map((r: any) => r.updateParagraphStyle);
    expect(ps.map((p) => [p.range.startIndex, p.paragraphStyle.pageBreakBefore])).toEqual([
      [1, false],
      [3, true],
    ]);
  });

  it("insert mode keeps the final newline, strips inherited bullets and never styles the next paragraph", () => {
    const c = compileSpec({ blocks: [{ type: "paragraph", text: "New" }] }, { insertAt: 20, tabId: "t.0", trailing: "existing" });
    expect(c.requests[0]).toEqual({ insertText: { location: { index: 20, tabId: "t.0" }, text: "New\n" } });
    expect(c.requests[1]).toEqual({ deleteParagraphBullets: { range: { startIndex: 20, endIndex: 24, tabId: "t.0" } } });
    expect(c.layout.end).toBe(24);
    const ranges = c.requests.flatMap(indicesOf);
    expect(Math.max(...ranges)).toBeLessThanOrEqual(24);
    // New text is NORMAL_TEXT even when inserted next to a heading.
    expect((c.requests.find((r) => "updateParagraphStyle" in r) as any).updateParagraphStyle.paragraphStyle.namedStyleType).toBe("NORMAL_TEXT");
  });
});

describe("golden resume against the 2026-10-08 reference", () => {
  const c = compileSpec(resumeSpec, opts);

  it("produces exactly the reference structure: paragraphs, tables and cell ranges", () => {
    const refParas: { p: number; end: number; text: string }[] = [];
    const refTables: { start: number; end: number; cells: { start: number; end: number }[][] }[] = [];
    const walk = (items: any[]) => {
      for (const el of items) {
        if ("p" in el) refParas.push({ p: el.p, end: el.end, text: el.text.replace(/\n$/, "") });
        else {
          refTables.push({ start: el.table, end: el.end, cells: el.cells.map((row: any[]) => row.map((x) => ({ start: x.start, end: x.end }))) });
          el.cells.forEach((row: any[]) => row.forEach((cell) => walk(cell.content)));
        }
      }
    };
    walk(reference.body as any[]);
    const sorted = [...c.layout.paragraphs].sort((a, b) => a.start - b.start);
    const refSorted = [...refParas].sort((a, b) => a.p - b.p);
    expect(sorted.map((p) => [p.start, p.end, p.text])).toEqual(refSorted.map((p) => [p.p, p.end, p.text]));
    expect(c.layout.tables.map((t) => ({ start: t.start, end: t.end, cells: t.cells }))).toEqual(refTables);
    expect(c.layout.end).toBe(2387);
  });

  it("is one batch of a size like the reference build (~180 requests), with no index past the end", () => {
    expect(c.requests.length).toBeGreaterThan(100);
    expect(c.requests.length).toBeLessThan(260);
    const all = c.requests.flatMap(indicesOf);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...all)).toBeLessThanOrEqual(c.layout.end);
    expect(c.stats.insertTable).toBe(3);
    expect(c.stats.createParagraphBullets).toBe(3);
  });

  it("starts with the page setup and puts every style after every insert", () => {
    expect(types(c)[0]).toBe("updateDocumentStyle");
    const lastInsert = types(c).lastIndexOf("insertText");
    const firstStyle = types(c).findIndex((t) => t.startsWith("update") && t !== "updateDocumentStyle");
    expect(lastInsert).toBeLessThan(firstStyle);
  });
});
