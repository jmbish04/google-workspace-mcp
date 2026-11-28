/**
 * @fileoverview Resolve a parsed layout spec into flat, fully specified
 * paragraph/run/cell styles: theme tokens become RGB, presets are merged, and
 * document defaults fill the gaps.
 *
 * Precedence for character fields (lowest first): document body defaults →
 * table header defaults (first row) → paragraph preset → paragraph fields →
 * run preset → run fields. Paragraph fields: document `lineSpacing` →
 * paragraph preset → paragraph fields. Document `bodySize` does not apply to a
 * heading role (the heading keeps its named-style size unless the spec sets
 * one).
 *
 * @example
 * ```typescript
 * import { createResolver } from "@/backend/docs/spec/resolve";
 * const r = createResolver(spec);
 * r.color("accent"); // → { red: 0.0588, green: 0.545, blue: 0.490 }
 * ```
 */
import type { LayoutSpec, Preset, Run } from "@/backend/docs/spec/schema";

/** RGB in 0..1, as the Docs API wants it. */
export interface Rgb {
  red: number;
  green: number;
  blue: number;
}

/** A fully resolved run style (every managed field has a value or is deliberately unset). */
export interface RunStyle {
  font?: string;
  size?: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  smallCaps: boolean;
  color?: Rgb;
  highlight?: Rgb;
  baseline: "NONE" | "SUPERSCRIPT" | "SUBSCRIPT";
  link?: string;
}

/** A resolved paragraph border. */
export interface Border {
  width: number;
  color: Rgb;
  padding: number;
  dash: "SOLID" | "DOT" | "DASH";
}

/** A fully resolved paragraph style. */
export interface ParaStyle {
  role: string;
  align: "START" | "CENTER" | "END" | "JUSTIFIED";
  lineSpacing: number;
  spaceAbove: number;
  spaceBelow: number;
  keepWithNext: boolean;
  keepLinesTogether: boolean;
  /** undefined = leave the list's own indentation alone (list items only). */
  indentStart?: number;
  indentFirstLine?: number;
  indentEnd: number;
  borderBottom?: Border;
  borderTop?: Border;
  shading?: Rgb;
  pageBreakBefore: boolean;
}

/** A resolved cell border side. */
export interface CellBorder {
  width: number;
  color: Rgb;
  dash: "SOLID" | "DOT" | "DASH";
}

/** A resolved cell style; undefined fields are left as Google sets them. */
export interface CellStyle {
  background?: Rgb;
  padding?: { top?: number; bottom?: number; left?: number; right?: number };
  borders?: { top?: CellBorder; bottom?: CellBorder; left?: CellBorder; right?: CellBorder };
  valign?: "TOP" | "MIDDLE" | "BOTTOM";
}

/** Character fields a source may carry. */
type RunSource = Partial<Pick<Run, "font" | "size" | "bold" | "italic" | "underline" | "strikethrough" | "smallCaps" | "color" | "highlight" | "baseline">> & {
  link?: string;
};

const RUN_KEYS = ["font", "size", "bold", "italic", "underline", "strikethrough", "smallCaps", "color", "highlight", "baseline"] as const;
const PARA_KEYS = [
  "align",
  "lineSpacing",
  "spaceAbove",
  "spaceBelow",
  "keepWithNext",
  "keepLinesTogether",
  "indentStart",
  "indentFirstLine",
  "indentEnd",
  "borderBottom",
  "borderTop",
  "shading",
] as const;

/**
 * Convert `#RGB` / `#RRGGBB` to Docs RGB.
 *
 * @param hex - color string
 * @returns `{ red, green, blue }` in 0..1 (rounded to 4 decimals)
 * @throws Error for a malformed hex
 */
export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Not a hex color: ${hex}`);
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const ch = (i: number) => Math.round((parseInt(h.slice(i, i + 2), 16) / 255) * 10000) / 10000;
  return { red: ch(0), green: ch(2), blue: ch(4) };
}

/** Pick the defined keys of `src` listed in `keys`. */
function pick<T extends object>(src: T | undefined, keys: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  if (!src) return out as Partial<T>;
  for (const k of keys) {
    const v = (src as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/** The resolver for one spec. */
export interface Resolver {
  color(value: string): Rgb;
  font(value: string): string;
  /** Character defaults of a paragraph-like block (doc → header → preset → own). */
  paragraphRunBase(block: RunSource & { style?: string }, opts: { heading: boolean; header?: RunSource }): RunSource;
  /** Full style of one run on top of a paragraph's run base. */
  runStyle(base: RunSource, run: Partial<Run>): RunStyle;
  /** Full paragraph style. */
  paraStyle(block: Record<string, unknown> & { style?: string }, opts: { role: string; listItem: boolean; pageBreakBefore?: boolean }): ParaStyle;
  /** Resolved cell style (table defaults → per-cell). */
  cellStyle(...layers: (Record<string, unknown> | undefined)[]): CellStyle;
  /** Style of a spacer (or gap) paragraph of `height` points. */
  spacer(height: number): { para: ParaStyle; run: RunStyle };
}

/**
 * Build the resolver for a parsed spec.
 *
 * @param spec - output of `layoutSpecSchema.parse`
 * @returns token/preset resolution functions
 */
export function createResolver(spec: LayoutSpec): Resolver {
  const theme = spec.theme;
  const presets: Record<string, Preset> = spec.styles ?? {};
  const doc = spec.document ?? {};

  const color = (value: string): Rgb => hexToRgb(value.startsWith("#") ? value : (theme.colors[value] ?? value));
  const font = (value: string): string => theme.fonts[value] ?? value;
  const preset = (name?: string): Preset | undefined => (name ? presets[name] : undefined);

  const border = (b: any): Border | undefined =>
    b ? { width: b.width ?? 1, color: color(b.color ?? "#000000"), padding: b.padding ?? 0, dash: b.dash ?? "SOLID" } : undefined;
  const cellBorder = (b: any): CellBorder | undefined => {
    if (b === undefined) return undefined;
    if (b === "none") return { width: 0, color: color("#ffffff"), dash: "SOLID" };
    return { width: b.width ?? 1, color: color(b.color ?? "#000000"), dash: b.dash ?? "SOLID" };
  };

  return {
    color,
    font,
    paragraphRunBase(block, opts) {
      const base: RunSource = {};
      if (doc.bodyFont) base.font = doc.bodyFont;
      if (doc.bodySize && !opts.heading) base.size = doc.bodySize;
      if (doc.bodyColor) base.color = doc.bodyColor;
      return { ...base, ...pick(opts.header, RUN_KEYS), ...pick(preset(block.style), RUN_KEYS), ...pick(block, RUN_KEYS) };
    },
    runStyle(base, run) {
      const merged: RunSource = { ...base, ...pick(preset(run.style), RUN_KEYS), ...pick(run, RUN_KEYS) };
      return {
        ...(merged.font ? { font: font(merged.font) } : {}),
        ...(merged.size !== undefined ? { size: merged.size } : {}),
        bold: merged.bold ?? false,
        italic: merged.italic ?? false,
        underline: merged.underline ?? Boolean(run.link),
        strikethrough: merged.strikethrough ?? false,
        smallCaps: merged.smallCaps ?? false,
        ...(merged.color ? { color: color(merged.color) } : {}),
        ...(merged.highlight ? { highlight: color(merged.highlight) } : {}),
        baseline: merged.baseline ?? "NONE",
        ...(run.link ? { link: run.link } : {}),
      };
    },
    paraStyle(block, opts) {
      const p: Record<string, any> = { ...pick(preset(block.style), PARA_KEYS), ...pick(block, PARA_KEYS) };
      const role = (block.role as string) ?? preset(block.style)?.role ?? opts.role;
      return {
        role,
        align: p.align ?? "START",
        lineSpacing: p.lineSpacing ?? doc.lineSpacing ?? 115,
        spaceAbove: p.spaceAbove ?? 0,
        spaceBelow: p.spaceBelow ?? 0,
        keepWithNext: p.keepWithNext ?? false,
        keepLinesTogether: p.keepLinesTogether ?? false,
        ...(p.indentStart !== undefined || !opts.listItem ? { indentStart: p.indentStart ?? 0 } : {}),
        ...(p.indentFirstLine !== undefined || !opts.listItem ? { indentFirstLine: p.indentFirstLine ?? 0 } : {}),
        indentEnd: p.indentEnd ?? 0,
        ...(p.borderBottom ? { borderBottom: border(p.borderBottom) } : {}),
        ...(p.borderTop ? { borderTop: border(p.borderTop) } : {}),
        ...(p.shading ? { shading: color(p.shading) } : {}),
        pageBreakBefore: opts.pageBreakBefore ?? false,
      };
    },
    cellStyle(...layers) {
      const merged: Record<string, any> = {};
      for (const l of layers) if (l) for (const k of ["background", "padding", "borders", "valign"]) if (l[k] !== undefined) merged[k] = l[k];
      const out: CellStyle = {};
      if (merged.background) out.background = color(merged.background);
      if (merged.padding !== undefined) {
        const p = merged.padding;
        out.padding = typeof p === "number" ? { top: p, bottom: p, left: p, right: p } : p;
      }
      if (merged.borders !== undefined) {
        const b = merged.borders;
        if (b === "none" || "width" in b || "color" in b || "dash" in b) {
          const one = cellBorder(b);
          out.borders = { top: one, bottom: one, left: one, right: one };
        } else {
          out.borders = { top: cellBorder(b.top), bottom: cellBorder(b.bottom), left: cellBorder(b.left), right: cellBorder(b.right) };
        }
      }
      if (merged.valign) out.valign = String(merged.valign).toUpperCase() as CellStyle["valign"];
      return out;
    },
    spacer(height) {
      return {
        para: {
          role: "NORMAL_TEXT",
          align: "START",
          lineSpacing: 100,
          spaceAbove: 0,
          spaceBelow: 0,
          keepWithNext: false,
          keepLinesTogether: false,
          indentStart: 0,
          indentFirstLine: 0,
          indentEnd: 0,
          pageBreakBefore: false,
        },
        run: { size: height, bold: false, italic: false, underline: false, strikethrough: false, smallCaps: false, baseline: "NONE" },
      };
    },
  };
}
