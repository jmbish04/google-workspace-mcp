/**
 * @fileoverview The pure index core of the batch-first Docs engine: UTF-16
 * lengths, empty-table formulas, fill order and final positions, tab
 * flattening, case folding, the document outline and literal find.
 *
 * Why one module: the code-mode sandbox gets these functions as SOURCE TEXT
 * (`fn.toString()`, see `mcp/sandbox-docs-helpers.ts`). A call from one helper
 * to a helper in ANOTHER module is compiled to a module-namespace access
 * (`__vite_ssr_import_0__.flattenTabs(...)` under Vite), which does not exist
 * in the sandbox. Calls between functions of the same module stay plain local
 * names, so every sandbox helper lives here.
 *
 * SANDBOX RULE for every function in this file: a top-level `function`
 * declaration that uses only its parameters, other functions of this file, and
 * inline anonymous callbacks. No imports, no module constants, no nested named
 * functions. `positions.ts`, `outline.ts`, `find.ts` and `locate.ts` re-export
 * from here; import from whichever names the concern.
 *
 * Measured facts the formulas encode (2026-10-08, 1x1 + 1x3 + 1x2 tables at
 * the end of an empty doc): table starts 2, 8, 18; cell paragraph starts 5;
 * 11, 13, 15; 21, 23. A table inserted at `i` starts at `i + 1`, its empty cell
 * (r, c) paragraph is at `i + 4 + r(2C+1) + 2c`, and it ends at `i + 3 + R(2C+1)`
 * where the next empty paragraph (the next insertAt) starts.
 *
 * @example
 * ```typescript
 * import { emptyTableCellIndex, outlineDoc, findAll } from "@/backend/docs/index-core";
 * emptyTableCellIndex(7, 1, 3, 0, 2); // → 15
 * ```
 */

// ---- UTF-16 and table positions -------------------------------------------

/** Size of a table to lay out. */
export interface TableShape {
  rows: number;
  columns: number;
}

/** One empty cell of a laid-out table. */
export interface EmptyCell {
  row: number;
  col: number;
  /** Start index of the cell's (empty) paragraph — where its text is inserted. */
  start: number;
}

/** One laid-out empty table. */
export interface EmptyTableLayout {
  /** Index the table was inserted at (start of the empty paragraph before it). */
  insertAt: number;
  /** The table element's start index (`tableStartLocation`). */
  tableStart: number;
  /** The table element's end index. */
  tableEnd: number;
  /** Start of the empty paragraph after the table (the next insertAt). */
  after: number;
  cells: EmptyCell[];
}

/**
 * Length of a string in UTF-16 code units — the unit Docs indices use.
 *
 * @param text - any string
 * @returns its UTF-16 length (an emoji or other astral character counts 2)
 * @example utf16Length("a😀") // → 3
 */
export function utf16Length(text: string): number {
  return String(text ?? "").length;
}

/**
 * Start index of the table element for a table inserted at `insertAt`.
 *
 * @param insertAt - index passed to `insertTable.location`
 * @returns `insertAt + 1`
 */
export function tableStartIndex(insertAt: number): number {
  return insertAt + 1;
}

/**
 * Start index of the paragraph inside empty cell (r, c).
 *
 * @param insertAt - index the table is inserted at
 * @param rows - table rows (unused by the formula; kept for a readable call site)
 * @param cols - table columns
 * @param r - zero-based row
 * @param c - zero-based column
 * @returns `insertAt + 4 + r(2C+1) + 2c`
 * @throws RangeError when (r, c) is outside the table
 * @example emptyTableCellIndex(1, 1, 1, 0, 0) // → 5
 */
export function emptyTableCellIndex(insertAt: number, rows: number, cols: number, r: number, c: number): number {
  if (r < 0 || c < 0 || r >= rows || c >= cols) {
    throw new RangeError(`Cell (${r}, ${c}) is outside a ${rows}x${cols} table.`);
  }
  return insertAt + 4 + r * (2 * cols + 1) + 2 * c;
}

/**
 * End index of an empty table inserted at `insertAt`.
 *
 * @param insertAt - index the table is inserted at
 * @param rows - table rows
 * @param cols - table columns
 * @returns `insertAt + 3 + R(2C+1)`
 */
export function tableEndIndex(insertAt: number, rows: number, cols: number): number {
  return insertAt + 3 + rows * (2 * cols + 1);
}

/**
 * Start of the empty paragraph after an empty table — the index the NEXT table
 * (or text) goes at.
 *
 * @param insertAt - index the table was inserted at
 * @param rows - table rows
 * @param cols - table columns
 * @returns `insertAt + 3 + R(2C+1)`
 * @example afterTableParagraphIndex(1, 1, 1) // → 7
 */
export function afterTableParagraphIndex(insertAt: number, rows: number, cols: number): number {
  return tableEndIndex(insertAt, rows, cols);
}

/**
 * Lay out empty tables inserted one after another, each at the paragraph that
 * follows the previous one.
 *
 * @param insertAt - index of the empty paragraph the first table goes before
 * @param shapes - table sizes, in document order
 * @returns one layout per table, with every empty cell's paragraph start
 * @example layoutEmptyTables(1, [{ rows: 1, columns: 1 }]) // → [{ tableStart: 2, cells: [{ start: 5 }], after: 7, … }]
 */
export function layoutEmptyTables(insertAt: number, shapes: TableShape[]): EmptyTableLayout[] {
  const out: EmptyTableLayout[] = [];
  let at = insertAt;
  for (const shape of shapes) {
    const cells: EmptyCell[] = [];
    for (let r = 0; r < shape.rows; r++) {
      for (let c = 0; c < shape.columns; c++) {
        cells.push({ row: r, col: c, start: emptyTableCellIndex(at, shape.rows, shape.columns, r, c) });
      }
    }
    const end = tableEndIndex(at, shape.rows, shape.columns);
    out.push({ insertAt: at, tableStart: tableStartIndex(at), tableEnd: end, after: end, cells });
    at = end;
  }
  return out;
}

/**
 * Order cells for filling: highest start index first, so no fill moves a cell
 * that is still to be filled.
 *
 * @param cells - cells with a `start` index (any extra fields are kept)
 * @returns a new array, last cell first
 */
export function fillOrder<T extends { start: number }>(cells: T[]): T[] {
  return [...cells].sort((a, b) => b.start - a.start);
}

/**
 * Final start index of each cell's first paragraph after every cell is filled.
 * A cell moves right by the total length inserted into all cells before it.
 *
 * @param cells - cells in document order, each with its empty-table `start`
 * @param insertedLengths - UTF-16 length inserted into each cell, same order
 * @returns final start indices, same order
 * @throws RangeError when the two arrays differ in length
 */
export function finalCellStarts(cells: { start: number }[], insertedLengths: number[]): number[] {
  if (cells.length !== insertedLengths.length) {
    throw new RangeError(`finalCellStarts: ${cells.length} cells but ${insertedLengths.length} lengths.`);
  }
  const order = cells.map((c, i) => ({ start: c.start, i })).sort((a, b) => a.start - b.start);
  const out: number[] = cells.map(() => 0);
  let shift = 0;
  for (const o of order) {
    out[o.i] = o.start + shift;
    shift += insertedLengths[o.i];
  }
  return out;
}

// ---- Tabs and case folding ------------------------------------------------

/**
 * Lower-case a string one UTF-16 code unit at a time, preserving length exactly.
 * `String.prototype.toLowerCase()` on the whole string can change length (e.g.
 * "İ" → "i̇", 1 code unit → 2), which would desync every index computed against
 * the original string. Folding per unit and leaving a unit unchanged whenever
 * its own lower-case form is a different length keeps every index exact; the
 * only cost is that those rare characters match case-sensitively.
 *
 * @param s - text to fold
 * @returns `s` with each length-preserving code unit lower-cased
 */
export function foldCase(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const lower = s[i].toLowerCase();
    out += lower.length === 1 ? lower : s[i];
  }
  return out;
}

/**
 * Every tab of a raw document, each parent before its `childTabs`, depth-first.
 * `docs_list_tabs` flattens `childTabs` the same way, so a tab id it handed the
 * agent must resolve here too — scanning only the top-level `tabs` rejects a
 * valid child-tab id with "Tab not found".
 *
 * @param rawDoc - `documents.get` JSON (the `includeTabsContent` shape)
 * @returns the flattened tab list; empty for a legacy `body`-only document
 */
export function flattenTabs(rawDoc: any): any[] {
  // Iterative pre-order walk (no nested function): this function is also
  // injected into the code-mode sandbox by source text, see positions.ts.
  const out: any[] = [];
  const stack: any[] = (Array.isArray(rawDoc?.tabs) ? rawDoc.tabs : []).slice().reverse();
  while (stack.length) {
    const tab = stack.pop();
    out.push(tab);
    const children: any[] = Array.isArray(tab?.childTabs) ? tab.childTabs : [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out;
}

// ---- Outline ---------------------------------------------------------------

/** One structural element. */
export interface OutlineItem {
  tabId: string;
  kind: "paragraph" | "table" | "sectionBreak" | "tableOfContents";
  start: number;
  end: number;
  /** namedStyleType of a paragraph. */
  style?: string;
  /** true for a list paragraph. */
  bullet?: boolean;
  /** Table number in the tab, in document order (0-based). For a cell paragraph: its table. */
  table?: number;
  /** [row, col] of the cell a paragraph sits in. */
  cell?: [number, number];
  rows?: number;
  columns?: number;
  /** Text preview (60 chars max, no trailing newline). */
  text?: string;
  /** true when the paragraph carries a pending suggestion. */
  suggestions?: boolean;
}

/** The outline of one tab. */
export interface TabOutline {
  tabId: string;
  title: string;
  /** End index of the tab body. */
  endIndex: number;
  items: OutlineItem[];
}

/** Outline of a whole document (or of one tab). */
export interface DocOutline {
  tabs: TabOutline[];
}

/**
 * Text preview of a paragraph, with pending suggestions marked.
 *
 * @param paragraph - a raw `paragraph`
 * @param max - preview length cap
 * @returns `{ text, suggestions }`
 */
export function paragraphPreview(paragraph: any, max: number): { text: string; suggestions: boolean } {
  let text = "";
  let suggestions = false;
  for (const el of paragraph?.elements ?? []) {
    const run = el?.textRun;
    if (run && typeof run.content === "string") {
      const content = run.content.replace(/\n$/, "");
      if (run.suggestedInsertionIds?.length) {
        text += "[+" + content + "]";
        suggestions = true;
      } else if (run.suggestedDeletionIds?.length) {
        text += "[-" + content + "]";
        suggestions = true;
      } else {
        text += content;
      }
      if (run.suggestedTextStyleChanges && Object.keys(run.suggestedTextStyleChanges).length) suggestions = true;
    } else if (el?.inlineObjectElement) text += "[image]";
    else if (el?.footnoteReference) text += "[footnote]";
    else if (el?.person) text += "[person]";
    else if (el?.richLink) text += "[link]";
    else if (el?.pageBreak) text += "[page break]";
    else if (el?.horizontalRule) text += "[rule]";
    else if (el?.dateElement) text += "[date]";
  }
  if (paragraph?.suggestedParagraphStyleChanges && Object.keys(paragraph.suggestedParagraphStyleChanges).length) {
    suggestions = true;
  }
  if (text.length > max) text = text.slice(0, max - 1) + "…";
  return { text, suggestions };
}

/**
 * Append outline items for a list of structural elements (recurses into cells).
 *
 * @param content - raw body (or cell) content
 * @param tabId - tab the content belongs to
 * @param out - items accumulate here
 * @param state - `{ tables }`: running table counter for the tab
 * @param where - table number and cell of the enclosing cell, or null at body level
 * @param max - preview length cap
 * @returns nothing; fills `out`
 */
export function outlineContent(
  content: any[],
  tabId: string,
  out: OutlineItem[],
  state: { tables: number },
  where: { table: number; cell: [number, number] } | null,
  max: number,
): void {
  for (const el of content ?? []) {
    const start = typeof el?.startIndex === "number" ? el.startIndex : 0;
    const end = typeof el?.endIndex === "number" ? el.endIndex : start;
    if (el?.paragraph) {
      const preview = paragraphPreview(el.paragraph, max);
      const item: OutlineItem = {
        tabId,
        kind: "paragraph",
        start,
        end,
        style: el.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT",
        text: preview.text,
      };
      if (el.paragraph.bullet) item.bullet = true;
      if (where) {
        item.table = where.table;
        item.cell = where.cell;
      }
      if (preview.suggestions) item.suggestions = true;
      out.push(item);
    } else if (el?.table) {
      const table = state.tables++;
      out.push({ tabId, kind: "table", start, end, table, rows: el.table.rows, columns: el.table.columns });
      const rows: any[] = el.table.tableRows ?? [];
      for (let r = 0; r < rows.length; r++) {
        const cells: any[] = rows[r]?.tableCells ?? [];
        for (let c = 0; c < cells.length; c++) {
          outlineContent(cells[c]?.content ?? [], tabId, out, state, { table, cell: [r, c] }, max);
        }
      }
    } else if (el?.sectionBreak) {
      out.push({ tabId, kind: "sectionBreak", start, end });
    } else if (el?.tableOfContents) {
      out.push({ tabId, kind: "tableOfContents", start, end });
    }
  }
}

/**
 * Outline every tab of a document, or one tab.
 *
 * @param raw - `documents.get` JSON (tabs shape or legacy body shape); a
 *   `docs_get_json` result with its `summary` works too
 * @param opts - `tabId` to outline one tab; `previewLength` (default 60)
 * @returns `{ tabs: [{ tabId, title, endIndex, items }] }`
 * @throws Error `Tab not found: <id>` for an unknown `tabId`
 */
export function outlineDoc(raw: any, opts: { tabId?: string; previewLength?: number } = {}): DocOutline {
  const max = opts.previewLength ?? 60;
  const tabs = flattenTabs(raw);
  const sources: { tabId: string; title: string; content: any[] }[] = tabs.length
    ? tabs.map((t: any) => ({
        tabId: String(t?.tabProperties?.tabId ?? ""),
        title: String(t?.tabProperties?.title ?? ""),
        content: t?.documentTab?.body?.content ?? [],
      }))
    : [{ tabId: "", title: "", content: raw?.body?.content ?? [] }];
  const picked = opts.tabId ? sources.filter((s) => s.tabId === opts.tabId) : sources;
  if (opts.tabId && !picked.length) throw new Error("Tab not found: " + opts.tabId);
  return {
    tabs: picked.map((s) => {
      const items: OutlineItem[] = [];
      outlineContent(s.content, s.tabId, items, { tables: 0 }, null, max);
      const last = s.content.length ? s.content[s.content.length - 1] : null;
      return { tabId: s.tabId, title: s.title, endIndex: typeof last?.endIndex === "number" ? last.endIndex : 1, items };
    }),
  };
}

/**
 * Render an outline as compact text lines (about 40% of the JSON size).
 *
 * Line forms: `P start-end STYLE [• ][t<table> r<row>c<col> ][~ ]"text"`,
 * `T start-end table <n> <rows>x<cols>`, `S start-end section`,
 * `TOC start-end`, and per tab a header `# tab <id> "<title>"` and a final
 * `END <tabId> <endIndex>`. `•` marks a bullet, `~` a pending suggestion.
 *
 * @param outline - result of {@link outlineDoc}
 * @returns the lines, in document order
 */
export function outlineLines(outline: DocOutline): string[] {
  const lines: string[] = [];
  for (const tab of outline.tabs) {
    lines.push("# tab " + tab.tabId + " " + JSON.stringify(tab.title));
    for (const i of tab.items) {
      if (i.kind === "paragraph") {
        const cell = i.cell ? "t" + i.table + " r" + i.cell[0] + "c" + i.cell[1] + " " : "";
        lines.push(
          "P " + i.start + "-" + i.end + " " + i.style + " " + (i.bullet ? "• " : "") + cell + (i.suggestions ? "~ " : "") + JSON.stringify(i.text ?? ""),
        );
      } else if (i.kind === "table") {
        lines.push("T " + i.start + "-" + i.end + " table " + i.table + " " + i.rows + "x" + i.columns);
      } else if (i.kind === "sectionBreak") {
        if (i.start > 0) lines.push("S " + i.start + "-" + i.end + " section");
      } else {
        lines.push("TOC " + i.start + "-" + i.end);
      }
    }
    lines.push("END " + tab.tabId + " " + tab.endIndex);
  }
  return lines;
}

// ---- Find ------------------------------------------------------------------

/** One match. */
export interface FindMatch {
  tabId: string;
  startIndex: number;
  endIndex: number;
  text: string;
  /** true when every covered run is bold, false when none is, "mixed" otherwise. */
  bold: boolean | "mixed";
  /** true when any covered run carries a pending suggestion. */
  inSuggestion: boolean;
  /** Table number in the tab (0-based) when the match is in a cell. */
  table?: number;
  /** [row, col] when the match is in a cell. */
  cell?: [number, number];
}

/** A text run slice of the searchable string. */
export interface FindSegment {
  start: number;
  content: string;
  offset: number;
  bold: boolean;
  suggestion: boolean;
  table: number | null;
  cell: [number, number] | null;
}

/**
 * Collect text runs in document order (recurses into table cells).
 *
 * @param content - raw body or cell content
 * @param acc - `{ segs, text, tables }` accumulator
 * @param where - enclosing table and cell, or null at body level
 * @returns nothing; fills `acc`
 */
export function collectFindSegments(
  content: any[],
  acc: { segs: FindSegment[]; text: string; tables: number },
  where: { table: number; cell: [number, number] } | null,
): void {
  for (const el of content ?? []) {
    for (const pe of el?.paragraph?.elements ?? []) {
      const run = pe?.textRun;
      if (run && typeof run.content === "string" && typeof pe.startIndex === "number") {
        acc.segs.push({
          start: pe.startIndex,
          content: run.content,
          offset: acc.text.length,
          bold: Boolean(run.textStyle?.bold),
          suggestion: Boolean(
            run.suggestedInsertionIds?.length ||
              run.suggestedDeletionIds?.length ||
              (run.suggestedTextStyleChanges && Object.keys(run.suggestedTextStyleChanges).length),
          ),
          table: where ? where.table : null,
          cell: where ? where.cell : null,
        });
        acc.text += run.content;
      }
    }
    if (el?.table) {
      const table = acc.tables++;
      const rows: any[] = el.table.tableRows ?? [];
      for (let r = 0; r < rows.length; r++) {
        const cells: any[] = rows[r]?.tableCells ?? [];
        for (let c = 0; c < cells.length; c++) collectFindSegments(cells[c]?.content ?? [], acc, { table, cell: [r, c] });
      }
    }
  }
}

/**
 * Every non-overlapping match of `find`.
 *
 * @param raw - `documents.get` JSON (or a `docs_get_json` result)
 * @param find - literal text (empty → no matches)
 * @param opts - `matchCase` (default true), `tabId` (default: every tab)
 * @returns matches in document order, tab by tab
 * @throws Error `Tab not found: <id>` for an unknown `tabId`
 */
export function findAll(raw: any, find: string, opts: { matchCase?: boolean; tabId?: string } = {}): FindMatch[] {
  if (!find) return [];
  const tabs = flattenTabs(raw);
  const sources: { tabId: string; content: any[] }[] = tabs.length
    ? tabs.map((t: any) => ({ tabId: String(t?.tabProperties?.tabId ?? ""), content: t?.documentTab?.body?.content ?? [] }))
    : [{ tabId: "", content: raw?.body?.content ?? [] }];
  const picked = opts.tabId ? sources.filter((s) => s.tabId === opts.tabId) : sources;
  if (opts.tabId && !picked.length) throw new Error("Tab not found: " + opts.tabId);
  const caseless = opts.matchCase === false;
  const needle = caseless ? foldCase(find) : find;
  const out: FindMatch[] = [];
  for (const src of picked) {
    const acc = { segs: [] as FindSegment[], text: "", tables: 0 };
    collectFindSegments(src.content, acc, null);
    const hay = caseless ? foldCase(acc.text) : acc.text;
    let from = 0;
    for (;;) {
      const hit = hay.indexOf(needle, from);
      if (hit === -1) break;
      const end = hit + needle.length;
      const covered = acc.segs.filter((s) => s.offset < end && s.offset + s.content.length > hit);
      let contiguous = true;
      for (let k = 1; k < covered.length; k++) {
        const prev = covered[k - 1];
        if (prev.start + prev.content.length !== covered[k].start) contiguous = false;
      }
      if (contiguous && covered.length) {
        const first = covered[0];
        const boldCount = covered.filter((s) => s.bold).length;
        const match: FindMatch = {
          tabId: src.tabId,
          startIndex: first.start + (hit - first.offset),
          endIndex: first.start + (hit - first.offset) + needle.length,
          text: acc.text.slice(hit, end),
          bold: boldCount === 0 ? false : boldCount === covered.length ? true : "mixed",
          inSuggestion: covered.some((s) => s.suggestion),
        };
        if (first.cell) {
          match.table = first.table as number;
          match.cell = first.cell;
        }
        out.push(match);
        from = end;
      } else {
        from = hit + 1;
      }
    }
  }
  return out;
}
