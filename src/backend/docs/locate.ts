/**
 * @file docs/locate.ts
 * @description Pure helpers to locate a table's indices in a raw Docs document,
 * so the factories can fill/style cells after inserting a table. Testable with
 * synthetic doc JSON.
 */

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
function foldCase(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const lower = s[i].toLowerCase();
    out += lower.length === 1 ? lower : s[i];
  }
  return out;
}

export interface TableCell {
  rowIndex: number;
  colIndex: number;
  /** Start index of the cell's first paragraph (where text is inserted). */
  startIndex: number;
}
export interface LocatedTable {
  /** The table element's own start index (for tableCellLocation.tableStartLocation). */
  tableStartIndex: number;
  rows: number;
  cols: number;
  cells: TableCell[];
}

/** Body content for a tab (with includeTabsContent) or the legacy root body. */
export function docBodyContent(rawDoc: any, tabId?: string): any[] {
  if (Array.isArray(rawDoc?.tabs) && rawDoc.tabs.length) {
    const tab = tabId ? rawDoc.tabs.find((t: any) => t?.tabProperties?.tabId === tabId) : rawDoc.tabs[0];
    return tab?.documentTab?.body?.content ?? [];
  }
  return Array.isArray(rawDoc?.body?.content) ? rawDoc.body.content : [];
}

/** Locate the LAST table in the doc (the one a factory just inserted). */
export function findLastTable(rawDoc: any, tabId?: string): LocatedTable | null {
  const content = docBodyContent(rawDoc, tabId);
  let last: any = null;
  for (const el of content) if (el?.table) last = el;
  if (!last) return null;

  const cells: TableCell[] = [];
  const tableRows: any[] = last.table.tableRows ?? [];
  tableRows.forEach((row: any, r: number) => {
    (row.tableCells ?? []).forEach((cell: any, c: number) => {
      const startIndex = cell?.content?.[0]?.startIndex;
      if (typeof startIndex === "number") cells.push({ rowIndex: r, colIndex: c, startIndex });
    });
  });
  return {
    tableStartIndex: last.startIndex,
    rows: tableRows.length,
    cols: tableRows[0]?.tableCells?.length ?? 0,
    cells,
  };
}

/** The covered slice of one Docs text run. */
export interface TextRun {
  startIndex: number;
  endIndex: number;
  content: string;
  textStyle: Record<string, unknown>;
}

/** A located literal match: its UTF-16 document range and the run slices it covers. */
export interface LocatedText {
  startIndex: number;
  endIndex: number;
  runs: TextRun[];
}

/**
 * Find the nth literal occurrence of `find` in a raw Docs document and resolve
 * its real UTF-16 index range. Walks paragraphs and table cells in order.
 * Shared by docs_style_text (via GoogleDocsClient.findElement) and docs_edit_text.
 *
 * @param rawDoc - `documents.get` JSON (legacy `body` or `includeTabsContent` `tabs`)
 * @param find - literal text to locate (empty → null)
 * @param instance - 1-based occurrence (overlapping occurrences count)
 * @param opts - `matchCase` (default true), `tabId` (default first tab)
 * @returns the range plus covered run slices, or null when not found
 * @example
 * locateText(doc, "ready for review") // → { startIndex: 22, endIndex: 38, runs: [...] }
 */
export function locateText(
  rawDoc: any,
  find: string,
  instance = 1,
  opts: { matchCase?: boolean; tabId?: string } = {},
): LocatedText | null {
  if (!find) return null;
  const segs: { startIndex: number; content: string; textStyle: Record<string, unknown>; offset: number }[] = [];
  let full = "";
  const walk = (content: any[]): void => {
    for (const el of content ?? []) {
      for (const pe of el?.paragraph?.elements ?? []) {
        const c = pe?.textRun?.content;
        if (typeof c === "string" && typeof pe.startIndex === "number") {
          segs.push({ startIndex: pe.startIndex, content: c, textStyle: pe.textRun.textStyle ?? {}, offset: full.length });
          full += c;
        }
      }
      for (const row of el?.table?.tableRows ?? []) {
        for (const cell of row?.tableCells ?? []) walk(cell?.content);
      }
    }
  };
  walk(docBodyContent(rawDoc, opts.tabId));

  const caseless = opts.matchCase === false;
  const hay = caseless ? foldCase(full) : full;
  const needle = caseless ? foldCase(find) : find;

  let from = 0;
  for (let n = 1; ; n++) {
    const hit = hay.indexOf(needle, from);
    if (hit === -1) return null;
    if (n === instance) {
      const end = hit + needle.length;
      const runs: TextRun[] = [];
      for (const s of segs) {
        const sEnd = s.offset + s.content.length;
        if (sEnd <= hit || s.offset >= end) continue;
        const a = Math.max(hit, s.offset) - s.offset;
        const b = Math.min(end, sEnd) - s.offset;
        runs.push({ startIndex: s.startIndex + a, endIndex: s.startIndex + b, content: s.content.slice(a, b), textStyle: s.textStyle });
      }
      return { startIndex: runs[0].startIndex, endIndex: runs[runs.length - 1].endIndex, runs };
    }
    from = hit + 1;
  }
}
