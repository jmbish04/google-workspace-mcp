/**
 * @fileoverview The read-only `docs` helper object of the code-mode sandbox.
 *
 * A `code_mode_run` snippet can call the same pure position helpers the host
 * uses, with no import and no network:
 *
 * ```js
 * const json = await tools.docs_get_json({ documentId });
 * const outline = docs.outline(json);              // = docs_outline items
 * const hits = docs.find(json, "EXPERIENCE");      // = docs_find matches
 * const at = docs.cellIndex(insertAt, R, C, r, c); // empty-table cell paragraph
 * ```
 *
 * The sandbox cannot import host modules, so the helpers travel as SOURCE
 * TEXT: {@link buildDocsHelperSource} concatenates `fn.toString()` of every
 * function in the set and freezes a `docs` object over them. All of them live
 * in ONE module, so calls between them are plain local names (a cross-module
 * call compiles to a namespace access that does not exist in the sandbox), and
 * a bundler rename changes the declaration and its callers together. That only holds while each helper obeys
 * the SANDBOX RULE in `docs/index-core.ts`: a top-level `function` declaration
 * that uses only its parameters, other functions of {@link SANDBOX_FUNCTIONS},
 * and inline anonymous callbacks.
 *
 * @example
 * ```typescript
 * import { buildDocsHelperSource } from "@/backend/mcp/sandbox-docs-helpers";
 * const prelude = buildDocsHelperSource(); // "function utf16Length(text) {…}\n…\nconst docs = Object.freeze({…});"
 * ```
 */
import {
  afterTableParagraphIndex,
  collectFindSegments,
  emptyTableCellIndex,
  fillOrder,
  finalCellStarts,
  findAll,
  flattenTabs,
  foldCase,
  layoutEmptyTables,
  outlineContent,
  outlineDoc,
  outlineLines,
  paragraphPreview,
  tableEndIndex,
  tableStartIndex,
  utf16Length,
} from "@/backend/docs/index-core";

/** Every function whose source goes into the sandbox (the dependency closure of the public helpers). */
export const SANDBOX_FUNCTIONS: Function[] = [
  utf16Length,
  tableStartIndex,
  emptyTableCellIndex,
  tableEndIndex,
  afterTableParagraphIndex,
  layoutEmptyTables,
  fillOrder,
  finalCellStarts,
  flattenTabs,
  foldCase,
  paragraphPreview,
  outlineContent,
  outlineDoc,
  outlineLines,
  collectFindSegments,
  findAll,
];

/** Public name in the sandbox → host function. Documented in `apiGuide()`. */
export const SANDBOX_DOCS_API: Record<string, Function> = {
  outline: outlineDoc,
  outlineLines,
  find: findAll,
  cellIndex: emptyTableCellIndex,
  tableStart: tableStartIndex,
  tableEnd: tableEndIndex,
  afterTable: afterTableParagraphIndex,
  layoutTables: layoutEmptyTables,
  fillOrder,
  finalCellStarts,
  utf16Length,
};

/**
 * Module-source prelude that declares the helper functions and a frozen
 * `docs` object. Injected at the top of the code-mode harness module.
 *
 * @returns JavaScript source text
 * @throws Error when a public helper is missing from {@link SANDBOX_FUNCTIONS}
 */
export function buildDocsHelperSource(): string {
  for (const [key, fn] of Object.entries(SANDBOX_DOCS_API)) {
    if (!SANDBOX_FUNCTIONS.includes(fn)) throw new Error(`docs.${key} is not in SANDBOX_FUNCTIONS`);
  }
  // A bundler may wrap nested functions in a `__name(fn, "x")` helper; the
  // helpers avoid nested named functions, but a no-op keeps a stray call safe.
  const prelude = "var __name = typeof __name === 'function' ? __name : (f) => f;";
  const decls = SANDBOX_FUNCTIONS.map((fn) => fn.toString()).join("\n");
  const api = Object.entries(SANDBOX_DOCS_API)
    .map(([key, fn]) => `${key}: ${fn.name}`)
    .join(", ");
  return `${prelude}\n${decls}\nconst docs = Object.freeze({ ${api} });`;
}
