/**
 * @fileoverview `docs_find`: every non-overlapping match of a literal string,
 * with its exact UTF-16 range, bold flag (true | false | "mixed"), pending
 * suggestion flag, and table/cell. A match never crosses a non-text element or
 * a cell boundary.
 *
 * Re-exported from `index-core.ts` (sandbox-safe; also `docs.find(json, text)`
 * inside `code_mode_run`).
 *
 * @example
 * ```typescript
 * import { findAll } from "@/backend/docs/find";
 * findAll(raw, "EXPERIENCE"); // → [{ tabId: "t.0", startIndex: 1035, endIndex: 1045, … }]
 * ```
 */
export { collectFindSegments, findAll, type FindMatch, type FindSegment } from "@/backend/docs/index-core";
