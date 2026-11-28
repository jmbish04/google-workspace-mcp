/**
 * @fileoverview `table_factory` as a thin wrapper over the spec compiler: a 2D
 * array of strings plus look options becomes a one-table layout spec, which
 * `docs/spec/compile.ts` turns into ONE guarded batch (the old factory needed 3
 * round trips: insert, read, fill, read, style).
 *
 * Theme `default` keeps the old look: dark-blue (#1f4e79) header fill, white
 * bold centered header text, header cells vertically centered, 1 pt black
 * borders on every cell. Options add what the old factory could not do:
 * borders (including `"none"` for a layout table), header row on/off, per-cell
 * fills, padding and fixed column widths.
 *
 * @example
 * ```typescript
 * import { buildTableFactorySpec } from "@/backend/docs/table-spec";
 * const spec = buildTableFactorySpec([["Name", "Qty"], ["Bolts", "40"]], { columnWidths: [300, null] });
 * ```
 */
import type { LayoutSpecInput } from "@/backend/docs/spec/schema";

/** Look options for {@link buildTableFactorySpec}. */
export interface TableFactoryOptions {
  /** Named look. Only `default` exists; options below override it. */
  theme?: string;
  /** First row is a header (fill + white bold centered text). Default true. */
  header?: boolean;
  /** `"none"` or a border for every cell. Default 1 pt black. */
  borders?: "none" | { width?: number; color?: string };
  /** Header fill color. Default #1f4e79. */
  headerFill?: string;
  /** Header text color. Default #ffffff. */
  headerColor?: string;
  /** Per-cell fill colors (null = none), same shape as the data. */
  fills?: (string | null)[][];
  /** Cell padding in points (all sides). */
  padding?: number;
  /** Fixed width per column in points (null = share the rest evenly). */
  columnWidths?: (number | null)[];
  /** Text size in points for every cell. */
  fontSize?: number;
}

/**
 * Build the layout spec for a data table.
 *
 * @param data - rows of cell strings (rows may be ragged; short rows are padded with "")
 * @param opts - look options
 * @returns a one-block layout spec (`blocks: [table]`)
 * @throws Error for an empty data array
 */
export function buildTableFactorySpec(data: string[][], opts: TableFactoryOptions): LayoutSpecInput {
  const rows = data.length;
  const cols = Math.max(0, ...data.map((r) => r.length));
  if (!rows || !cols) throw new Error("data must be a non-empty 2D array");
  const header = opts.header !== false;
  const borders = opts.borders === "none" ? "none" : { width: opts.borders?.width ?? 1, color: opts.borders?.color ?? "#000000" };
  return {
    blocks: [
      {
        type: "table",
        columns: opts.columnWidths
          ? Array.from({ length: cols }, (_, c) => (opts.columnWidths?.[c] != null ? { width: opts.columnWidths[c]! } : {}))
          : cols,
        cell: { borders, ...(opts.padding !== undefined ? { padding: opts.padding } : {}) },
        ...(header
          ? { header: { background: opts.headerFill ?? "#1f4e79", color: opts.headerColor ?? "#ffffff", bold: true, valign: "middle" as const } }
          : {}),
        rows: data.map((row, r) => ({
          cells: Array.from({ length: cols }, (_, c) => {
            const fill = opts.fills?.[r]?.[c];
            return {
              ...(fill ? { background: fill } : {}),
              blocks: [
                {
                  type: "paragraph" as const,
                  text: String(row[c] ?? ""),
                  ...(header && r === 0 ? { align: "CENTER" as const } : {}),
                  ...(opts.fontSize ? { size: opts.fontSize } : {}),
                },
              ],
            };
          }),
        })),
      },
    ],
  };
}
