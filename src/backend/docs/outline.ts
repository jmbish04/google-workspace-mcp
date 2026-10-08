/**
 * @fileoverview `docs_outline`: one entry per structural element of a Google
 * Doc (range, kind, named style, bullet, table/cell, tab, 60-char preview with
 * pending suggestions marked `[+…]`/`[-…]`), and each tab's body end index.
 *
 * Re-exported from `index-core.ts` (sandbox-safe; also `docs.outline(json)`
 * inside `code_mode_run`).
 *
 * @example
 * ```typescript
 * import { outlineDoc, outlineLines } from "@/backend/docs/outline";
 * outlineLines(outlineDoc(raw, { tabId: "t.0" })); // ['# tab t.0 "Tab 1"', …, 'END t.0 2387']
 * ```
 */
export {
  outlineContent,
  outlineDoc,
  outlineLines,
  paragraphPreview,
  type DocOutline,
  type OutlineItem,
  type TabOutline,
} from "@/backend/docs/index-core";
