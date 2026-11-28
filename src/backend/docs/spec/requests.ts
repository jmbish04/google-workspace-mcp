/**
 * @fileoverview Docs API request builders for the spec compiler: text style,
 * paragraph style, table cell style, column widths and row heights.
 *
 * Every builder sets an explicit `fields` mask. Text and paragraph styles name
 * every field the compiler manages, so a field the spec leaves unset is RESET
 * (to the named style's value) instead of inherited from whatever text the
 * insert landed next to — that is what keeps `insert` mode from turning new
 * text into a heading or a bulleted, bold, linked run.
 *
 * Adjacent ranges with identical styles are merged by {@link mergeRanges} to
 * keep the batch small.
 *
 * @example
 * ```typescript
 * import { textStyleRequest } from "@/backend/docs/spec/requests";
 * textStyleRequest({ start: 5, end: 15 }, { bold: true, … }, "t.0");
 * ```
 */
import type { Border, CellBorder, CellStyle, ParaStyle, Rgb, RunStyle } from "@/backend/docs/spec/resolve";

/** A Docs API request object. */
export type DocsRequest = Record<string, unknown>;

/** Half-open index range. */
export interface Range {
  start: number;
  end: number;
}

const pt = (magnitude: number) => ({ magnitude, unit: "PT" });
const rgb = (c: Rgb) => ({ color: { rgbColor: c } });

/** Text style fields the compiler always writes. */
export const TEXT_FIELDS =
  "weightedFontFamily,fontSize,bold,italic,underline,strikethrough,smallCaps,foregroundColor,backgroundColor,baselineOffset,link";

/**
 * Docs `textStyle` object for a resolved run style.
 *
 * @param s - resolved run style
 * @returns the API `textStyle` (unset fields omitted, so the mask resets them)
 */
export function apiTextStyle(s: RunStyle): Record<string, unknown> {
  return {
    ...(s.font ? { weightedFontFamily: { fontFamily: s.font, weight: 400 } } : {}),
    ...(s.size !== undefined ? { fontSize: pt(s.size) } : {}),
    bold: s.bold,
    italic: s.italic,
    underline: s.underline,
    strikethrough: s.strikethrough,
    smallCaps: s.smallCaps,
    ...(s.color ? { foregroundColor: rgb(s.color) } : {}),
    ...(s.highlight ? { backgroundColor: rgb(s.highlight) } : {}),
    baselineOffset: s.baseline,
    ...(s.link ? { link: { url: s.link } } : {}),
  };
}

/**
 * One `updateTextStyle` request.
 *
 * @param range - characters to style
 * @param style - resolved run style
 * @param tabId - target tab
 * @returns the request
 */
export function textStyleRequest(range: Range, style: RunStyle, tabId?: string | null): DocsRequest {
  return {
    updateTextStyle: {
      range: { startIndex: range.start, endIndex: range.end, ...(tabId ? { tabId } : {}) },
      textStyle: apiTextStyle(style),
      fields: TEXT_FIELDS,
    },
  };
}

const apiBorder = (b: Border | undefined) =>
  b
    ? { width: pt(b.width), color: rgb(b.color), padding: pt(b.padding), dashStyle: b.dash }
    : { width: pt(0), color: rgb({ red: 1, green: 1, blue: 1 }), padding: pt(0), dashStyle: "SOLID" };

/**
 * Docs `paragraphStyle` + field mask for a resolved paragraph style.
 *
 * @param s - resolved paragraph style
 * @param inTable - true for paragraphs inside a table cell: Google refuses
 *   `pageBreakBefore` there ("Cannot update page-break-before when the range
 *   contains paragraphs in a table", measured 2026-10-08), so it is left out
 * @returns `{ paragraphStyle, fields }`; indent fields are left out for a list
 *   item that sets none, so the list keeps its own indentation
 */
export function apiParagraphStyle(s: ParaStyle, inTable = false): { paragraphStyle: Record<string, unknown>; fields: string } {
  const style: Record<string, unknown> = {
    namedStyleType: s.role,
    alignment: s.align,
    lineSpacing: s.lineSpacing,
    spaceAbove: pt(s.spaceAbove),
    spaceBelow: pt(s.spaceBelow),
    keepWithNext: s.keepWithNext,
    keepLinesTogether: s.keepLinesTogether,
    indentEnd: pt(s.indentEnd),
    borderBottom: apiBorder(s.borderBottom),
    borderTop: apiBorder(s.borderTop),
    pageBreakBefore: s.pageBreakBefore,
  };
  const fields = [
    "namedStyleType",
    "alignment",
    "lineSpacing",
    "spaceAbove",
    "spaceBelow",
    "keepWithNext",
    "keepLinesTogether",
    "indentEnd",
    "borderBottom",
    "borderTop",
    "pageBreakBefore",
    "shading",
  ];
  if (s.shading) style.shading = { backgroundColor: rgb(s.shading) };
  if (inTable) {
    delete style.pageBreakBefore;
    fields.splice(fields.indexOf("pageBreakBefore"), 1);
  }
  if (s.indentStart !== undefined) {
    style.indentStart = pt(s.indentStart);
    fields.push("indentStart");
  }
  if (s.indentFirstLine !== undefined) {
    style.indentFirstLine = pt(s.indentFirstLine);
    fields.push("indentFirstLine");
  }
  return { paragraphStyle: style, fields: fields.join(",") };
}

/**
 * One `updateParagraphStyle` request.
 *
 * @param range - any range inside the paragraphs to style
 * @param style - resolved paragraph style
 * @param tabId - target tab
 * @param inTable - the range holds table-cell paragraphs (see {@link apiParagraphStyle})
 * @returns the request
 */
export function paragraphStyleRequest(range: Range, style: ParaStyle, tabId?: string | null, inTable = false): DocsRequest {
  const { paragraphStyle, fields } = apiParagraphStyle(style, inTable);
  return {
    updateParagraphStyle: {
      range: { startIndex: range.start, endIndex: range.end, ...(tabId ? { tabId } : {}) },
      paragraphStyle,
      fields,
    },
  };
}

const apiCellBorder = (b: CellBorder) => ({ width: pt(b.width), color: rgb(b.color), dashStyle: b.dash });

/**
 * One `updateTableCellStyle` request for cell (row, col), or null when the
 * cell style sets nothing.
 *
 * @param tableStart - the table element's start index
 * @param row - zero-based row
 * @param col - zero-based column
 * @param s - resolved cell style
 * @param tabId - target tab
 * @returns the request, or null
 */
export function cellStyleRequest(tableStart: number, row: number, col: number, s: CellStyle, tabId?: string | null): DocsRequest | null {
  const style: Record<string, unknown> = {};
  const fields: string[] = [];
  if (s.background) {
    style.backgroundColor = rgb(s.background);
    fields.push("backgroundColor");
  }
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const pad = s.padding?.[side];
    if (pad !== undefined) {
      const key = `padding${side[0].toUpperCase()}${side.slice(1)}`;
      style[key] = pt(pad);
      fields.push(key);
    }
    const border = s.borders?.[side];
    if (border) {
      const key = `border${side[0].toUpperCase()}${side.slice(1)}`;
      style[key] = apiCellBorder(border);
      fields.push(key);
    }
  }
  if (s.valign) {
    style.contentAlignment = s.valign;
    fields.push("contentAlignment");
  }
  if (!fields.length) return null;
  return {
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: { tableStartLocation: { index: tableStart, ...(tabId ? { tabId } : {}) }, rowIndex: row, columnIndex: col },
        rowSpan: 1,
        columnSpan: 1,
      },
      tableCellStyle: style,
      fields: fields.join(","),
    },
  };
}

/**
 * Column width requests: fixed widths where given, the rest evenly distributed.
 *
 * @param tableStart - the table element's start index
 * @param widths - one entry per column (undefined = share the rest)
 * @param tabId - target tab
 * @returns 1 request when no width is fixed, else 1 per fixed column + 1 for the rest
 */
export function columnRequests(tableStart: number, widths: (number | undefined)[], tabId?: string | null): DocsRequest[] {
  const loc = { index: tableStart, ...(tabId ? { tabId } : {}) };
  const fixed = widths.map((w, i) => ({ w, i })).filter((x) => x.w !== undefined);
  const even = widths.map((w, i) => ({ w, i })).filter((x) => x.w === undefined);
  const out: DocsRequest[] = [];
  if (even.length) {
    out.push({
      updateTableColumnProperties: {
        tableStartLocation: loc,
        ...(fixed.length ? { columnIndices: even.map((x) => x.i) } : {}),
        tableColumnProperties: { widthType: "EVENLY_DISTRIBUTED" },
        fields: "widthType",
      },
    });
  }
  for (const f of fixed) {
    out.push({
      updateTableColumnProperties: {
        tableStartLocation: loc,
        columnIndices: [f.i],
        tableColumnProperties: { widthType: "FIXED_WIDTH", width: pt(f.w!) },
        fields: "widthType,width",
      },
    });
  }
  return out;
}

/**
 * Minimum row height request.
 *
 * @param tableStart - the table element's start index
 * @param row - zero-based row
 * @param minHeight - points
 * @param tabId - target tab
 * @returns the request
 */
export function rowHeightRequest(tableStart: number, row: number, minHeight: number, tabId?: string | null): DocsRequest {
  return {
    updateTableRowStyle: {
      tableStartLocation: { index: tableStart, ...(tabId ? { tabId } : {}) },
      rowIndices: [row],
      tableRowStyle: { minRowHeight: pt(minHeight) },
      fields: "minRowHeight",
    },
  };
}

/**
 * Merge contiguous ranges that carry the same value (by JSON key).
 *
 * @param items - ranges with a value, in document order
 * @returns merged ranges, in document order
 * @example mergeRanges([{start:1,end:3,value:a},{start:3,end:5,value:a}]) // → [{start:1,end:5,value:a}]
 */
export function mergeRanges<T>(items: { start: number; end: number; value: T }[]): { start: number; end: number; value: T }[] {
  const out: { start: number; end: number; value: T; key: string }[] = [];
  for (const it of items) {
    if (it.end <= it.start) continue;
    const key = JSON.stringify(it.value);
    const last = out[out.length - 1];
    if (last && last.end === it.start && last.key === key) last.end = it.end;
    else out.push({ ...it, key });
  }
  return out.map(({ key: _k, ...rest }) => rest);
}
