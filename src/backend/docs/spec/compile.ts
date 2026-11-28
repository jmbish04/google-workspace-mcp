/**
 * @fileoverview Compile a layout spec into ONE list of `documents.batchUpdate`
 * requests, using the method of the 2026-10-08 reference build.
 *
 * The batch has four phases, in this order:
 *
 * 1. Structure, forward: top-level text is inserted at a moving cursor, and
 *    each table is inserted EMPTY at the cursor (`insertTable` at `i` puts the
 *    table at `i + 1`; the next cursor is `i + 3 + R(2C+1)`, measured live).
 * 2. Fill, last cell first: every cell's text goes in at its empty-table index
 *    (`i + 4 + r(2C+1) + 2c`), from the last cell of the last table to the
 *    first, so no fill moves a cell still to be filled.
 * 3. Bullets (`createParagraphBullets` per list block; in `insert` mode the
 *    new paragraphs first lose any bullets they inherited).
 * 4. Styles at FINAL positions (computed by walking the final layout):
 *    paragraph styles, text styles, table cell styles, column widths, row
 *    heights. Adjacent identical style ranges are merged.
 *
 * A table always needs a paragraph before it. When text comes before a table,
 * that text is inserted WITHOUT its last newline, so the newline Google inserts
 * with the table ends it and no empty paragraph appears. Only a table that
 * starts the content or follows another table gets an empty "gap" paragraph,
 * styled to `gapBefore` points (default 1). The trailing paragraph after a
 * table that ends the document is styled to `document.trailingGap`.
 *
 * `trailing: "own"` (create mode, or an append at the end) means the empty
 * paragraph at `insertAt` belongs to the build: the last text merges into it.
 * `trailing: "existing"` (insert in the middle) means the paragraph at
 * `insertAt` is the document's own next paragraph and is never restyled.
 *
 * @example
 * ```typescript
 * import { compileSpec } from "@/backend/docs/spec/compile";
 * const { requests, layout } = compileSpec(spec, { insertAt: 1, tabId: "t.0", trailing: "own" });
 * await docs.batchUpdate(documentId, requests, { requiredRevisionId });
 * ```
 */
import { buildPageSetupRequest, type PageSetup } from "@/backend/docs/page-setup";
import { emptyTableCellIndex, tableEndIndex, utf16Length } from "@/backend/docs/index-core";
import { createResolver, type ParaStyle, type Resolver, type RunStyle, type CellStyle } from "@/backend/docs/spec/resolve";
import {
  cellStyleRequest,
  columnRequests,
  mergeRanges,
  paragraphStyleRequest,
  rowHeightRequest,
  textStyleRequest,
  type DocsRequest,
} from "@/backend/docs/spec/requests";
import { layoutSpecSchema, type Block, type CellBlock, type LayoutSpec, type TableBlock } from "@/backend/docs/spec/schema";

/** One paragraph of the intermediate representation. */
interface IRPara {
  runs: { text: string; style: RunStyle }[];
  /** Style of the paragraph's newline (and of an empty paragraph). */
  endStyle: RunStyle;
  para: ParaStyle;
  /** List block id + preset, for list items. */
  list?: { id: number; preset: string };
  /** A gap paragraph Google needs before a table (not from a block). */
  gap?: boolean;
}

interface IRCell {
  paras: IRPara[];
  style: CellStyle;
}

interface IRTable {
  kind: "table";
  rows: number;
  cols: number;
  cells: IRCell[][];
  widths: (number | undefined)[];
  minHeights: (number | undefined)[];
  gapBefore: number;
  /** pageBreakBefore requested for the gap paragraph before this table. */
  pageBreakBefore: boolean;
}

interface IRText {
  kind: "text";
  paras: IRPara[];
}

type IRItem = IRTable | IRText;

/** Where the compiled content lands, in FINAL positions. */
export interface CompiledLayout {
  /** Every paragraph the build styles (top level, gaps and cells), in document order. */
  paragraphs: { start: number; end: number; text: string; gap?: boolean; table?: number; cell?: [number, number] }[];
  tables: { start: number; end: number; rows: number; columns: number; cells: { start: number; end: number }[][] }[];
  /** First index after the built content. */
  end: number;
}

/** Result of {@link compileSpec}. */
export interface CompiledSpec {
  requests: DocsRequest[];
  layout: CompiledLayout;
  /** UTF-16 units the batch adds to the document. */
  insertedLength: number;
  /** Count of requests per type. */
  stats: Record<string, number>;
  /** The parsed spec (defaults applied). */
  spec: LayoutSpec;
}

/** Options for {@link compileSpec}. */
export interface CompileOptions {
  /** Start index of the paragraph the content goes before (1 for an empty doc). */
  insertAt: number;
  /** Target tab id (set on every location and range). */
  tabId?: string | null;
  /** Whether the paragraph at `insertAt` belongs to the build. Default "own". */
  trailing?: "own" | "existing";
  /** Apply `document` page setup. Default true. */
  pageSetup?: boolean;
}

const BULLET = "BULLET_DISC_CIRCLE_SQUARE";
const NUMBERED = "NUMBERED_DECIMAL_ALPHA_ROMAN";

/** Lowered paragraph text: runs joined, soft breaks kept. */
const paraText = (p: IRPara) => p.runs.map((r) => r.text).join("");

/**
 * Lower paragraph-like blocks (paragraph, heading, list, spacer) to IR paragraphs.
 *
 * @param blocks - blocks in order
 * @param r - resolver
 * @param ctx - running list id counter (shared, so ids stay unique) and pending page break
 * @param header - table header defaults (first row only)
 * @returns IR paragraphs
 */
function lowerParagraphs(
  blocks: CellBlock[],
  r: Resolver,
  ctx: { listId: number; pageBreak?: boolean },
  header?: Record<string, unknown>,
): IRPara[] {
  const out: IRPara[] = [];
  const takeBreak = () => {
    const b = ctx.pageBreak === true;
    ctx.pageBreak = false;
    return b;
  };
  const one = (block: Record<string, any>, role: string, list?: IRPara["list"]): IRPara => {
    const heading = role !== "NORMAL_TEXT";
    const base = r.paragraphRunBase(block, { heading, header: header as any });
    const runs = (block.runs ?? (block.text !== undefined ? [{ text: block.text }] : [])).map((run: any) => ({
      text: String(run.text).replace(/\r/g, ""),
      style: r.runStyle(base, run),
    }));
    const last = runs.length ? runs[runs.length - 1].style : r.runStyle(base, {});
    const { link: _link, ...endStyle } = last;
    return {
      runs: runs.filter((x: { text: string }) => x.text.length > 0),
      endStyle: { ...endStyle, underline: last.link ? false : endStyle.underline },
      para: r.paraStyle(block, { role, listItem: Boolean(list), pageBreakBefore: takeBreak() }),
      ...(list ? { list } : {}),
    };
  };
  for (const b of blocks) {
    if (b.type === "paragraph") out.push(one(b, b.role ?? "NORMAL_TEXT"));
    else if (b.type === "heading") {
      const role = b.level === "title" ? "TITLE" : b.level === "subtitle" ? "SUBTITLE" : `HEADING_${b.level}`;
      out.push(one({ keepWithNext: true, ...b }, role));
    } else if (b.type === "list") {
      const list = { id: ctx.listId++, preset: b.preset ?? (b.ordered ? NUMBERED : BULLET) };
      const { items, type: _t, ordered: _o, preset: _p, ...shared } = b;
      for (const item of items) {
        const fields = typeof item === "string" ? { text: item } : item;
        // Item fields win over the list's shared fields; an item preset replaces the list preset.
        out.push(one({ ...shared, ...fields, style: fields.style ?? shared.style }, "NORMAL_TEXT", list));
      }
    } else if (b.type === "spacer") {
      const s = r.spacer(b.height);
      out.push({ runs: [], endStyle: s.run, para: { ...s.para, pageBreakBefore: takeBreak() } });
    }
  }
  return out;
}

/**
 * Lower the spec's top-level blocks to IR items (text groups and tables).
 *
 * @param spec - parsed spec
 * @param r - resolver
 * @returns IR items in order
 */
function lower(spec: LayoutSpec, r: Resolver): IRItem[] {
  const items: IRItem[] = [];
  const ctx: { listId: number; pageBreak?: boolean } = { listId: 0 };
  let pending: CellBlock[] = [];
  const flush = () => {
    if (!pending.length) return;
    items.push({ kind: "text", paras: lowerParagraphs(pending, r, ctx) });
    pending = [];
  };
  for (const block of spec.blocks as Block[]) {
    if (block.type === "pageBreak") {
      flush();
      ctx.pageBreak = true;
    } else if (block.type === "table") {
      flush();
      items.push(lowerTable(block, r, ctx));
    } else {
      pending.push(block);
    }
  }
  flush();
  return items;
}

/**
 * Lower one table block.
 *
 * @param t - table block
 * @param r - resolver
 * @param ctx - list id counter and pending page break
 * @returns the IR table
 * @throws Error when a row has a different number of cells than the columns
 */
function lowerTable(t: TableBlock, r: Resolver, ctx: { listId: number; pageBreak?: boolean }): IRTable {
  const cols = typeof t.columns === "number" ? t.columns : t.columns.length;
  const widths = typeof t.columns === "number" ? Array.from({ length: cols }, () => undefined) : t.columns.map((c) => c.width);
  const pageBreakBefore = ctx.pageBreak === true;
  ctx.pageBreak = false;
  const cells = t.rows.map((row, ri) => {
    if (row.cells.length !== cols) {
      throw new Error(`Table row ${ri} has ${row.cells.length} cells but the table has ${cols} columns.`);
    }
    const header = ri === 0 ? t.header : undefined;
    return row.cells.map((cell) => {
      const paras = lowerParagraphs(cell.blocks, r, ctx, header);
      return {
        paras: paras.length ? paras : lowerParagraphs([{ type: "paragraph", text: "" }], r, ctx, header),
        style: r.cellStyle(t.cell, header, cell),
      };
    });
  });
  return {
    kind: "table",
    rows: t.rows.length,
    cols,
    cells,
    widths,
    minHeights: t.rows.map((row) => row.minHeight),
    gapBefore: t.gapBefore ?? 1,
    pageBreakBefore,
  };
}

/**
 * Compile a layout spec to a batchUpdate request list.
 *
 * @param input - the spec (validated with `layoutSpecSchema`)
 * @param opts - insertion point, tab, trailing-paragraph ownership, page setup
 * @returns requests, final layout, inserted length and per-type counts
 * @throws ZodError for an invalid spec (the issue path names the field)
 * @example
 * compileSpec({ blocks: [{ type: "paragraph", text: "Hi" }] }, { insertAt: 1, tabId: "t.0" }).requests
 * // → [insertText "Hi", updateParagraphStyle [1,4), updateTextStyle [1,4)]
 */
export function compileSpec(input: unknown, opts: CompileOptions): CompiledSpec {
  const spec = layoutSpecSchema.parse(input);
  const r = createResolver(spec);
  const tabId = opts.tabId ?? null;
  const own = (opts.trailing ?? "own") === "own";
  const items = lower(spec, r);
  const loc = (index: number) => ({ index, ...(tabId ? { tabId } : {}) });

  const requests: DocsRequest[] = [];
  const doc = spec.document;
  const setup: PageSetup = {
    ...(doc.pageMode ? { documentMode: doc.pageMode } : {}),
    ...(doc.margins ? { margins: doc.margins } : {}),
    ...(doc.pageSize ? { pageSize: doc.pageSize } : {}),
    ...(doc.landscape !== undefined ? { flipPageOrientation: doc.landscape } : {}),
  };
  if (opts.pageSetup !== false && Object.keys(setup).length) requests.push(buildPageSetupRequest({ ...setup, tabId }));

  // ---- Phase 1: structure, forward ---------------------------------------------
  // A table needs an empty gap paragraph before it when it starts the content,
  // follows another table, or carries a page break. Otherwise the text before
  // it omits its last newline (the table's own newline ends that paragraph).
  // Text that ends the build also omits it when the trailing paragraph is ours.
  const needsGap = (i: number) => {
    const item = items[i];
    return item.kind === "table" && (i === 0 || items[i - 1].kind === "table" || item.pageBreakBefore);
  };
  const omitFinal = (i: number) => {
    const next = items[i + 1];
    return next ? next.kind === "table" && !needsGap(i + 1) : own;
  };
  let cursor = opts.insertAt;
  let inserted = 0;
  const emptyCellStarts: { table: number; row: number; col: number; at: number }[] = [];
  items.forEach((item, i) => {
    if (item.kind === "text") {
      const texts = item.paras.map(paraText);
      const text = texts.join("\n") + (omitFinal(i) ? "" : "\n");
      if (text.length) {
        requests.push({ insertText: { location: loc(cursor), text } });
        cursor += utf16Length(text);
        inserted += utf16Length(text);
      }
    } else {
      requests.push({ insertTable: { rows: item.rows, columns: item.cols, location: loc(cursor) } });
      for (let row = 0; row < item.rows; row++) {
        for (let col = 0; col < item.cols; col++) {
          emptyCellStarts.push({ table: i, row, col, at: emptyTableCellIndex(cursor, item.rows, item.cols, row, col) });
        }
      }
      const next = tableEndIndex(cursor, item.rows, item.cols);
      inserted += next - cursor;
      cursor = next;
    }
  });

  // ---- Phase 2: fill cells, last first -----------------------------------------
  for (const c of [...emptyCellStarts].sort((a, b) => b.at - a.at)) {
    const table = items[c.table] as IRTable;
    const text = table.cells[c.row][c.col].paras.map(paraText).join("\n");
    if (text.length) {
      requests.push({ insertText: { location: loc(c.at), text } });
      inserted += utf16Length(text);
    }
  }

  // ---- Final layout walk ---------------------------------------------------------
  const layout: CompiledLayout = { paragraphs: [], tables: [], end: 0 };
  const placed: { para: IRPara; start: number; end: number; inCell: boolean }[] = [];
  const cellStyles: { tableStart: number; row: number; col: number; style: CellStyle }[] = [];
  const tableProps: { tableStart: number; widths: (number | undefined)[]; minHeights: (number | undefined)[] }[] = [];
  const place = (para: IRPara, start: number, meta: Record<string, unknown> = {}) => {
    const end = start + utf16Length(paraText(para)) + 1;
    placed.push({ para, start, end, inCell: "cell" in meta });
    layout.paragraphs.push({ start, end, text: paraText(para), ...meta });
    return end;
  };
  let pos = opts.insertAt;
  items.forEach((item, i) => {
    if (item.kind === "text") {
      for (const p of item.paras) pos = place(p, pos);
      return;
    }
    if (needsGap(i)) {
      const gap = r.spacer(item.gapBefore);
      pos = place({ runs: [], endStyle: gap.run, para: { ...gap.para, pageBreakBefore: item.pageBreakBefore }, gap: true }, pos, { gap: true });
    }
    const tableStart = pos;
    const tIndex = layout.tables.length;
    let p = tableStart + 1;
    const cellRanges: { start: number; end: number }[][] = [];
    item.cells.forEach((row, ri) => {
      p += 1;
      const rowRanges: { start: number; end: number }[] = [];
      row.forEach((cell, ci) => {
        const cellStart = p;
        p += 1;
        for (const para of cell.paras) p = place(para, p, { table: tIndex, cell: [ri, ci] });
        rowRanges.push({ start: cellStart, end: p });
        cellStyles.push({ tableStart, row: ri, col: ci, style: cell.style });
      });
      cellRanges.push(rowRanges);
    });
    const tableEnd = p + 1;
    layout.tables.push({ start: tableStart, end: tableEnd, rows: item.rows, columns: item.cols, cells: cellRanges });
    tableProps.push({ tableStart, widths: item.widths, minHeights: item.minHeights });
    pos = tableEnd;
  });
  if (own && items.length && items[items.length - 1].kind === "table") {
    const gap = r.spacer(doc.trailingGap ?? 1);
    pos = place({ runs: [], endStyle: gap.run, para: gap.para, gap: true }, pos, { gap: true });
  }
  layout.end = pos;

  // ---- Phase 3: bullets ----------------------------------------------------------
  const range = (start: number, end: number) => ({ startIndex: start, endIndex: end, ...(tabId ? { tabId } : {}) });
  if (!own) {
    // New paragraphs inherit the bullets of the paragraph they were split from.
    const topLevel = mergeRanges(placed.filter((x) => !x.inCell).map((x) => ({ start: x.start, end: x.end, value: 1 })));
    for (const t of topLevel) requests.push({ deleteParagraphBullets: { range: range(t.start, t.end) } });
  }
  const lists = new Map<number, { start: number; end: number; preset: string }>();
  for (const x of placed) {
    if (!x.para.list) continue;
    const l = lists.get(x.para.list.id);
    if (l) l.end = x.end;
    else lists.set(x.para.list.id, { start: x.start, end: x.end, preset: x.para.list.preset });
  }
  for (const l of lists.values()) requests.push({ createParagraphBullets: { range: range(l.start, l.end), bulletPreset: l.preset } });

  // ---- Phase 4: styles at final positions ----------------------------------------
  for (const m of mergeRanges(placed.map((x) => ({ start: x.start, end: x.end, value: { style: x.para.para, inCell: x.inCell } })))) {
    requests.push(paragraphStyleRequest(m, m.value.style, tabId, m.value.inCell));
  }
  const runRanges: { start: number; end: number; value: RunStyle }[] = [];
  for (const x of placed) {
    let at = x.start;
    for (const run of x.para.runs) {
      const len = utf16Length(run.text);
      runRanges.push({ start: at, end: at + len, value: run.style });
      at += len;
    }
    runRanges.push({ start: at, end: at + 1, value: x.para.endStyle });
  }
  for (const m of mergeRanges(runRanges)) requests.push(textStyleRequest(m, m.value, tabId));
  for (const c of cellStyles) {
    const req = cellStyleRequest(c.tableStart, c.row, c.col, c.style, tabId);
    if (req) requests.push(req);
  }
  for (const t of tableProps) {
    requests.push(...columnRequests(t.tableStart, t.widths, tabId));
    t.minHeights.forEach((h, row) => {
      if (h !== undefined) requests.push(rowHeightRequest(t.tableStart, row, h, tabId));
    });
  }

  const stats: Record<string, number> = {};
  for (const req of requests) {
    const k = Object.keys(req)[0];
    stats[k] = (stats[k] ?? 0) + 1;
  }
  return { requests, layout, insertedLength: inserted, stats, spec };
}
