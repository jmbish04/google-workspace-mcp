/**
 * @file docs/locate.ts
 * @description Pure helpers to locate a table's indices in a raw Docs document,
 * so the factories can fill/style cells after inserting a table. Testable with
 * synthetic doc JSON.
 */
import { flattenTabs, foldCase } from "@/backend/docs/index-core";

export { flattenTabs, foldCase };

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

/** Body content for a tab (with includeTabsContent, child tabs included) or the legacy root body. */
export function docBodyContent(rawDoc: any, tabId?: string): any[] {
  const tabs = flattenTabs(rawDoc);
  if (tabs.length) {
    const tab = tabId ? tabs.find((t: any) => t?.tabProperties?.tabId === tabId) : tabs[0];
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
  /** Set only when the run carries a pending tracked-change suggestion. */
  hasSuggestions?: true;
}

/**
 * Whether a raw `textRun` carries a pending tracked change — a suggested
 * insertion, a suggested deletion, or a suggested style change. The rendered
 * `content` reads as if every suggestion were accepted, so an edit planned
 * against it would write against text the document owner has not agreed to.
 *
 * @param textRun - a raw `paragraph.elements[].textRun`
 * @returns true when the run has at least one pending suggestion
 */
function runHasSuggestions(textRun: any): boolean {
  return Boolean(
    textRun?.suggestedInsertionIds?.length ||
      textRun?.suggestedDeletionIds?.length ||
      (textRun?.suggestedTextStyleChanges && Object.keys(textRun.suggestedTextStyleChanges).length),
  );
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
  const segs: {
    startIndex: number;
    content: string;
    textStyle: Record<string, unknown>;
    offset: number;
    hasSuggestions: boolean;
  }[] = [];
  let full = "";
  const walk = (content: any[]): void => {
    for (const el of content ?? []) {
      for (const pe of el?.paragraph?.elements ?? []) {
        const c = pe?.textRun?.content;
        if (typeof c === "string" && typeof pe.startIndex === "number") {
          segs.push({
            startIndex: pe.startIndex,
            content: c,
            textStyle: pe.textRun.textStyle ?? {},
            offset: full.length,
            hasSuggestions: runHasSuggestions(pe.textRun),
          });
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
        const run: TextRun = { startIndex: s.startIndex + a, endIndex: s.startIndex + b, content: s.content.slice(a, b), textStyle: s.textStyle };
        if (s.hasSuggestions) run.hasSuggestions = true;
        runs.push(run);
      }
      return { startIndex: runs[0].startIndex, endIndex: runs[runs.length - 1].endIndex, runs };
    }
    from = hit + 1;
  }
}
