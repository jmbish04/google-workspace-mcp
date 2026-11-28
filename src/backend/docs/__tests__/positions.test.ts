import { describe, expect, it } from "vitest";

import reference from "@/backend/docs/__fixtures__/reference-resume.structure.json";
import {
  afterTableParagraphIndex,
  emptyTableCellIndex,
  fillOrder,
  finalCellStarts,
  layoutEmptyTables,
  tableEndIndex,
  tableStartIndex,
  utf16Length,
} from "@/backend/docs/positions";

describe("utf16Length", () => {
  it("counts code units, so emoji and other astral characters count as 2", () => {
    expect(utf16Length("abc")).toBe(3);
    expect(utf16Length("😀")).toBe(2);
    expect(utf16Length("a😀b")).toBe(4);
    expect(utf16Length("𝔸")).toBe(2);
    expect(utf16Length("■■")).toBe(2);
    expect(utf16Length("")).toBe(0);
  });
});

describe("empty-table formulas (measured 2026-10-08: 3 tables at the end of an empty doc)", () => {
  it("puts the table start at insertAt + 1", () => {
    expect(tableStartIndex(1)).toBe(2);
    expect(tableStartIndex(7)).toBe(8);
    expect(tableStartIndex(17)).toBe(18);
  });

  it("gives the cell paragraph starts 5; 11,13,15; 21,23", () => {
    expect(emptyTableCellIndex(1, 1, 1, 0, 0)).toBe(5);
    expect([0, 1, 2].map((c) => emptyTableCellIndex(7, 1, 3, 0, c))).toEqual([11, 13, 15]);
    expect([0, 1].map((c) => emptyTableCellIndex(17, 1, 2, 0, c))).toEqual([21, 23]);
  });

  it("handles more than one row: row r adds r*(2C+1)", () => {
    // 2x2 at 1: row 0 cells 5,7; row 1 cells 10,12.
    expect(emptyTableCellIndex(1, 2, 2, 1, 0)).toBe(10);
    expect(emptyTableCellIndex(1, 2, 2, 1, 1)).toBe(12);
  });

  it("gives the paragraph after a table (the next insertAt) and the table end", () => {
    expect(afterTableParagraphIndex(1, 1, 1)).toBe(7);
    expect(afterTableParagraphIndex(7, 1, 3)).toBe(17);
    expect(tableEndIndex(1, 1, 1)).toBe(7);
    expect(tableEndIndex(17, 1, 2)).toBe(25);
  });

  it("lays out consecutive tables: starts 2, 8, 18", () => {
    const layout = layoutEmptyTables(1, [
      { rows: 1, columns: 1 },
      { rows: 1, columns: 3 },
      { rows: 1, columns: 2 },
    ]);
    expect(layout.map((t) => t.tableStart)).toEqual([2, 8, 18]);
    expect(layout.map((t) => t.insertAt)).toEqual([1, 7, 17]);
    expect(layout.map((t) => t.cells.map((c) => c.start))).toEqual([[5], [11, 13, 15], [21, 23]]);
    expect(layout.at(-1)!.after).toBe(25);
  });
});

describe("fill order and final positions", () => {
  const layout = layoutEmptyTables(1, [
    { rows: 1, columns: 1 },
    { rows: 1, columns: 3 },
    { rows: 1, columns: 2 },
  ]);
  const cells = layout.flatMap((t, table) => t.cells.map((c) => ({ ...c, table })));

  it("fills the last cell first", () => {
    expect(fillOrder(cells).map((c) => c.start)).toEqual([23, 21, 15, 13, 11, 5]);
  });

  it("reproduces the reference resume's final cell starts from its inserted lengths", () => {
    // Inserted length per cell = its final content length minus the cell's own trailing "\n".
    const refTables = (reference.body as any[]).filter((el) => "table" in el);
    const refCells = refTables.flatMap((t) => t.cells.flat());
    const inserted = refCells.map((c: any) => c.end - c.start - 2);
    const finals = finalCellStarts(cells, inserted);
    expect(finals).toEqual(refCells.map((c: any) => c.content[0].p));
    expect(finals).toEqual([5, 157, 204, 237, 277, 770]);
  });
});
