/**
 * @fileoverview Pure index math for Google Docs batches: UTF-16 lengths, the
 * empty-table formulas, fill order and final positions after cell fills.
 *
 * Re-exported from `index-core.ts` (the single module the code-mode sandbox
 * copies by source text). See that file for the measured formulas.
 *
 * @example
 * ```typescript
 * import { emptyTableCellIndex, utf16Length } from "@/backend/docs/positions";
 * emptyTableCellIndex(7, 1, 3, 0, 2); // → 15
 * utf16Length("a😀");                 // → 3
 * ```
 */
export {
  afterTableParagraphIndex,
  emptyTableCellIndex,
  fillOrder,
  finalCellStarts,
  layoutEmptyTables,
  tableEndIndex,
  tableStartIndex,
  utf16Length,
  type EmptyCell,
  type EmptyTableLayout,
  type TableShape,
} from "@/backend/docs/index-core";
