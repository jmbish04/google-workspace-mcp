/**
 * @fileoverview Where `docs_build_from_spec` and `docs_patch` put new blocks:
 * the empty-tab check for `create`, the anchor paragraph for `insert`, and the
 * before/after text check that proves an insert left the rest of the document
 * alone.
 *
 * An anchor is a TOP-LEVEL paragraph (not inside a table cell), found by its
 * heading text (`heading`, a heading/title paragraph whose text equals it,
 * case-insensitive, trimmed) or by a literal it contains (`text`). New content
 * goes right after it:
 * - when the next element is a paragraph, at that paragraph's start
 *   (`trailing: "existing"`: that paragraph is never restyled);
 * - when the anchor is the last paragraph or a table follows it, a newline is
 *   first inserted at the end of the anchor, and the new empty paragraph is the
 *   build's own (`trailing: "own"`), because text cannot be inserted at a
 *   table's start or after the body's final newline.
 *
 * @example
 * ```typescript
 * import { resolveAnchor } from "@/backend/docs/spec/anchor";
 * const at = resolveAnchor(content, { heading: "Experience" });
 * // → { insertAt: 120, trailing: "existing", prefix: [], anchor: { start: 108, end: 120, text: "Experience" } }
 * ```
 */

/** Anchor selector. */
export interface AnchorSpec {
  /** Text of a heading/title paragraph (case-insensitive, trimmed). */
  heading?: string;
  /** Literal text inside the paragraph. */
  text?: string;
  /** 1-based occurrence. Default 1. */
  instance?: number;
}

/** Where to insert, and any request needed first. */
export interface InsertPoint {
  insertAt: number;
  trailing: "own" | "existing";
  /** Requests to run before the compiled batch (an extra newline). */
  prefix: Record<string, unknown>[];
  anchor: { start: number; end: number; text: string; style: string } | null;
}

/** Plain text of a raw paragraph (text runs only). */
export function paragraphText(paragraph: any): string {
  return (paragraph?.elements ?? []).map((e: any) => e?.textRun?.content ?? "").join("");
}

/**
 * Check that a tab body is empty (only the section break and one empty paragraph).
 *
 * @param content - raw body content of the tab
 * @returns the start index of the empty paragraph (where a build goes)
 * @throws Error naming what the tab holds when it is not empty
 */
export function emptyBodyInsertPoint(content: any[]): InsertPoint {
  const els = (content ?? []).filter((el: any) => !el?.sectionBreak);
  const only = els.length === 1 ? els[0] : null;
  if (!only?.paragraph || paragraphText(only.paragraph) !== "\n") {
    const tables = els.filter((el: any) => el?.table).length;
    const chars = els.reduce((n: number, el: any) => n + (el?.paragraph ? paragraphText(el.paragraph).length : 0), 0);
    throw new Error(
      `mode "create" needs an empty tab, but this one has ${els.length} elements (${tables} tables, ${chars} characters of top-level text). Use mode "insert" with an anchor, or create a new doc or tab.`,
    );
  }
  return { insertAt: only.startIndex ?? 1, trailing: "own", prefix: [], anchor: null };
}

/**
 * Resolve an anchor paragraph to an insert point.
 *
 * @param content - raw body content of the tab
 * @param anchor - heading or text selector
 * @param tabId - tab for the prefix request
 * @returns the insert point
 * @throws Error when neither `heading` nor `text` is given, or no top-level paragraph matches
 */
export function resolveAnchor(content: any[], anchor: AnchorSpec, tabId?: string | null): InsertPoint {
  if (!anchor.heading && !anchor.text) throw new Error('mode "insert" needs anchor.heading or anchor.text.');
  const want = anchor.instance ?? 1;
  let seen = 0;
  for (let i = 0; i < content.length; i++) {
    const el = content[i];
    if (!el?.paragraph) continue;
    const text = paragraphText(el.paragraph).replace(/\n$/, "");
    const style = el.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT";
    const isHeading = /^(HEADING_\d|TITLE|SUBTITLE)$/.test(style);
    const hit = anchor.heading
      ? isHeading && text.trim().toLowerCase() === anchor.heading.trim().toLowerCase()
      : text.includes(anchor.text!);
    if (!hit || ++seen !== want) continue;
    const next = content[i + 1];
    const found = { start: el.startIndex, end: el.endIndex, text, style };
    if (next?.paragraph) return { insertAt: el.endIndex, trailing: "existing", prefix: [], anchor: found };
    return {
      insertAt: el.endIndex,
      trailing: "own",
      prefix: [{ insertText: { location: { index: el.endIndex - 1, ...(tabId ? { tabId } : {}) }, text: "\n" } }],
      anchor: found,
    };
  }
  const what = anchor.heading ? `heading "${anchor.heading}"` : `text ${JSON.stringify(anchor.text)}`;
  throw new Error(`Anchor not found: no top-level paragraph with ${what} (instance ${want}). Table cells are not searched; use docs_outline to see the paragraphs.`);
}

/**
 * Text of the body between two indices (text runs only, cells included).
 *
 * @param content - raw body content
 * @param from - start index (inclusive)
 * @param to - end index (exclusive)
 * @returns the characters of every text run inside [from, to)
 */
export function textBetween(content: any[], from: number, to: number): string {
  let out = "";
  const walk = (items: any[]): void => {
    for (const el of items ?? []) {
      for (const pe of el?.paragraph?.elements ?? []) {
        const c = pe?.textRun?.content;
        if (typeof c !== "string" || typeof pe.startIndex !== "number") continue;
        const a = Math.max(from, pe.startIndex);
        const b = Math.min(to, pe.startIndex + c.length);
        if (b > a) out += c.slice(a - pe.startIndex, b - pe.startIndex);
      }
      for (const row of el?.table?.tableRows ?? []) for (const cell of row?.tableCells ?? []) walk(cell?.content);
    }
  };
  walk(content);
  return out;
}

/** Body end index of raw content. */
export function bodyEnd(content: any[]): number {
  const last = content?.[content.length - 1];
  return typeof last?.endIndex === "number" ? last.endIndex : 1;
}

/**
 * Insert point at the end of a tab body (append). Reuses an empty last
 * paragraph; otherwise inserts a newline at the end of the last paragraph so
 * the build owns a fresh trailing paragraph.
 *
 * @param content - raw body content of the tab
 * @param tabId - tab for the prefix request
 * @returns the insert point (`trailing: "own"`)
 */
export function appendInsertPoint(content: any[], tabId?: string | null): InsertPoint {
  const last = content?.[content.length - 1];
  if (last?.paragraph && paragraphText(last.paragraph) === "\n") {
    return { insertAt: last.startIndex, trailing: "own", prefix: [], anchor: null };
  }
  const end = bodyEnd(content);
  return {
    insertAt: end,
    trailing: "own",
    prefix: [{ insertText: { location: { index: end - 1, ...(tabId ? { tabId } : {}) }, text: "\n" } }],
    anchor: null,
  };
}
