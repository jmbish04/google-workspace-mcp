/**
 * @fileoverview Pure, isomorphic helpers for reading and editing the Tiptap /
 * ProseMirror JSON stored in `documents.content`.
 *
 * The agent surface (see `agent-service.ts`) reads a document STRUCTURED — as an
 * ordered list of blocks with plain text — so a model can anchor a suggestion to
 * real text instead of raw HTML, and applies an accepted suggestion by editing
 * the text of a single text run.
 *
 * Design choice, mirroring the repo's `docs_edit_text`: an edit only applies when
 * the matched text lies WHOLLY within one text run. A match that straddles two
 * runs (e.g. a bold word inside a sentence) is refused with
 * `{ ok:false, reason:"spansMultipleNodes" }` rather than silently rewriting
 * mixed styling — the caller narrows the anchor and retries. No DOM, no
 * ProseMirror runtime: this runs the same in the Worker and under vitest.
 */

/** A minimal structural view of a ProseMirror node (doc / block / text). */
export interface PMNode {
  type: string;
  text?: string;
  content?: PMNode[];
  attrs?: Record<string, unknown>;
  marks?: unknown[];
  [key: string]: unknown;
}

/** One top-level block of a document, flattened for anchoring. */
export interface DocBlock {
  /** Position of this block among the document's top-level nodes. */
  index: number;
  /** ProseMirror node type (`paragraph`, `heading`, `bulletList`, …). */
  type: string;
  /** Concatenated plain text of every descendant text run in the block. */
  text: string;
  /** Heading level when `attrs.level` is present. */
  level?: number;
}

/** How a located span of text should change when a suggestion is applied. */
export type TextChange =
  | { kind: "replace"; text: string }
  | { kind: "insert_before"; text: string }
  | { kind: "insert_after"; text: string }
  | { kind: "delete" };

/** A stable text anchor: the substring to find, which occurrence, and an optional block scope. */
export interface TextAnchor {
  /** The exact substring to locate within a single text run. */
  find: string;
  /** 1-based occurrence to target when `find` appears more than once. Defaults to 1. */
  occurrence?: number;
  /** Restrict the search to this top-level block index (from {@link extractBlocks}). */
  blockIndex?: number;
}

/** Outcome of {@link applyTextChange}. */
export type ApplyResult =
  | { ok: true; content: PMNode; before: string; after: string }
  | { ok: false; reason: "notFound" | "spansMultipleNodes"; matches: number };

/** Narrow an unknown value to a usable ProseMirror doc root, or throw. */
function asDoc(content: unknown): PMNode {
  if (!content || typeof content !== "object") {
    throw new Error("Document content is not a ProseMirror/Tiptap JSON object.");
  }
  return content as PMNode;
}

/** Recursively collect every text run in document order. */
function collectTextNodes(node: PMNode, out: PMNode[]): void {
  if (node.type === "text" && typeof node.text === "string") {
    out.push(node);
    return;
  }
  for (const child of node.content ?? []) collectTextNodes(child, out);
}

/** Concatenate all descendant text of a node. */
function nodeText(node: PMNode): string {
  const runs: PMNode[] = [];
  collectTextNodes(node, runs);
  return runs.map((r) => r.text ?? "").join("");
}

/**
 * Flatten a document into its top-level blocks with plain text.
 * @param content - The ProseMirror/Tiptap document JSON.
 * @returns One {@link DocBlock} per top-level node, in order.
 * @example extractBlocks({ type:"doc", content:[{ type:"paragraph", content:[{type:"text",text:"Hi"}] }] })
 */
export function extractBlocks(content: unknown): DocBlock[] {
  const doc = asDoc(content);
  const blocks = doc.content ?? [];
  return blocks.map((block, index) => {
    const level = block.attrs && typeof block.attrs.level === "number" ? block.attrs.level : undefined;
    return { index, type: block.type, text: nodeText(block), ...(level !== undefined ? { level } : {}) };
  });
}

/**
 * The document's full plain text, blocks joined by newlines.
 * @param content - The ProseMirror/Tiptap document JSON.
 * @returns The concatenated plain text.
 */
export function extractPlainText(content: unknown): string {
  return extractBlocks(content)
    .map((b) => b.text)
    .join("\n");
}

/** Count how many times `find` appears wholly within a single text run (optionally scoped). */
function countMatches(runs: PMNode[], find: string): number {
  let n = 0;
  for (const run of runs) {
    const text = run.text ?? "";
    let from = text.indexOf(find);
    while (from !== -1) {
      n += 1;
      from = text.indexOf(find, from + Math.max(find.length, 1));
    }
  }
  return n;
}

/**
 * Apply a {@link TextChange} to the Nth single-run occurrence of an anchor.
 *
 * Operates on a deep clone, so the input is never mutated. Only edits text that
 * lies within one run; a cross-run match is refused (see file overview).
 *
 * @param content - The ProseMirror/Tiptap document JSON.
 * @param anchor - The substring, occurrence, and optional block scope to target.
 * @param change - What to do with the located span.
 * @returns `{ ok:true, content, before, after }` with the new document, or
 *   `{ ok:false, reason, matches }` when the anchor is missing or spans runs.
 * @example applyTextChange(doc, { find:"teh" }, { kind:"replace", text:"the" })
 */
export function applyTextChange(content: unknown, anchor: TextAnchor, change: TextChange): ApplyResult {
  const find = anchor.find;
  if (!find) return { ok: false, reason: "notFound", matches: 0 };
  const occurrence = Math.max(1, anchor.occurrence ?? 1);

  const doc = structuredClone(asDoc(content));
  const scope =
    anchor.blockIndex !== undefined ? doc.content?.[anchor.blockIndex] : undefined;
  const root = anchor.blockIndex !== undefined ? scope : doc;
  if (anchor.blockIndex !== undefined && !root) return { ok: false, reason: "notFound", matches: 0 };

  const runs: PMNode[] = [];
  collectTextNodes(root as PMNode, runs);
  const totalInRun = countMatches(runs, find);

  // Whole-document (not just single-run) match count, so the caller can tell
  // "no such text" from "that text spans styled runs".
  const wholeText =
    anchor.blockIndex !== undefined ? nodeText(root as PMNode) : extractPlainText(content);
  let wholeMatches = 0;
  for (let i = wholeText.indexOf(find); i !== -1; i = wholeText.indexOf(find, i + Math.max(find.length, 1))) {
    wholeMatches += 1;
  }

  if (totalInRun === 0) {
    return {
      ok: false,
      reason: wholeMatches > 0 ? "spansMultipleNodes" : "notFound",
      matches: wholeMatches,
    };
  }
  if (occurrence > totalInRun) return { ok: false, reason: "notFound", matches: totalInRun };

  // Walk runs again, counting matches, and edit the one that holds occurrence N.
  let seen = 0;
  for (const run of runs) {
    const text = run.text ?? "";
    let from = text.indexOf(find);
    while (from !== -1) {
      seen += 1;
      if (seen === occurrence) {
        const to = from + find.length;
        const matched = text.slice(from, to);
        let replacement: string;
        switch (change.kind) {
          case "replace":
            replacement = change.text;
            break;
          case "insert_before":
            replacement = change.text + matched;
            break;
          case "insert_after":
            replacement = matched + change.text;
            break;
          case "delete":
            replacement = "";
            break;
        }
        run.text = text.slice(0, from) + replacement + text.slice(to);
        return { ok: true, content: doc, before: matched, after: replacement };
      }
      from = text.indexOf(find, from + Math.max(find.length, 1));
    }
  }
  /* istanbul ignore next — unreachable: occurrence <= totalInRun guaranteed above */
  return { ok: false, reason: "notFound", matches: totalInRun };
}
