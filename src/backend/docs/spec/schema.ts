/**
 * @fileoverview The layout spec that `docs_build_from_spec` compiles to one
 * guarded `documents.batchUpdate`.
 *
 * The agent describes the design; the server writes the batch. A spec has:
 * - `document`: page mode, margins, page size, default body font/size/color,
 *   line spacing, and `maxPages` (a limit the render check reports against).
 * - `theme`: colors and fonts named ONCE (`ink`, `accent`, `heading`, `body`…);
 *   every color/font field takes a token name or a literal (`#0f8b7d`, `Lato`).
 * - `styles`: named presets (paragraph + run fields) that blocks and runs refer
 *   to with `style: "<name>"`, so a repeated look is set in one place.
 * - `blocks`: paragraph, heading, list, spacer, pageBreak, and layout table.
 *   Table cells hold the same blocks (except table and pageBreak).
 *
 * Units: sizes, spacing, padding, widths and margins are points (72 pt = 1 in);
 * `lineSpacing` is a percent (100 = single, 115 = Docs default).
 *
 * Token names and preset names are checked by a `superRefine`, so a bad spec
 * fails with a Zod error whose path names the field (for example
 * `blocks.2.rows.0.cells.1.blocks.0.runs.3.color`).
 *
 * @example
 * ```typescript
 * import { layoutSpecSchema } from "@/backend/docs/spec/schema";
 * const spec = layoutSpecSchema.parse({
 *   theme: { colors: { accent: "#0f8b7d" }, fonts: { body: "Lato" } },
 *   document: { pageMode: "PAGES", bodyFont: "body" },
 *   blocks: [{ type: "heading", level: 1, text: "Report", color: "accent" }],
 * });
 * ```
 */
import { z } from "zod";

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A color: `#RGB`, `#RRGGBB`, or a `theme.colors` token name. */
const color = z.string().min(1).describe("Hex (#RRGGBB) or a theme.colors token.");
/** A font family: a Google Docs font name or a `theme.fonts` token name. */
const font = z.string().min(1).describe("Font family (any Google Docs font) or a theme.fonts token.");
const pt = z.number().min(0);

/** Character-level fields, shared by runs, paragraphs (as defaults), presets and document defaults. */
const runFields = {
  font: font.optional(),
  size: z.number().positive().max(400).optional().describe("Font size in points."),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  smallCaps: z.boolean().optional(),
  color: color.optional().describe("Text color."),
  highlight: color.optional().describe("Background (highlight) color behind the text — use for tags/chips."),
  baseline: z.enum(["SUPERSCRIPT", "SUBSCRIPT", "NONE"]).optional(),
};

/** A paragraph border (section rule). */
const borderSchema = z.object({
  width: pt.default(1),
  color: color.default("#000000"),
  padding: pt.default(0).describe("Gap between text and rule, points."),
  dash: z.enum(["SOLID", "DOT", "DASH"]).default("SOLID"),
});

/** Paragraph-level fields. */
const paragraphFields = {
  align: z.enum(["START", "CENTER", "END", "JUSTIFIED"]).optional(),
  lineSpacing: z.number().min(50).max(500).optional().describe("Percent: 100 = single, 115 = Docs default."),
  spaceAbove: pt.optional(),
  spaceBelow: pt.optional(),
  keepWithNext: z.boolean().optional().describe("Keep on the same page as the next paragraph (set on headings)."),
  keepLinesTogether: z.boolean().optional(),
  indentStart: pt.optional(),
  indentFirstLine: pt.optional().describe("Indent of the first line (the bullet glyph in a list), from the margin."),
  indentEnd: pt.optional(),
  borderBottom: borderSchema.optional().describe("Rule under the paragraph (section titles)."),
  borderTop: borderSchema.optional(),
  shading: color.optional().describe("Paragraph background color."),
};

/** One text run. Text may not contain "\n" (use another paragraph) — "\u000b" is a soft line break. */
export const runSchema = z.object({
  text: z.string().refine((t) => !t.includes("\n") && !t.includes("\r"), {
    message: "A run cannot contain a newline; start a new paragraph block instead (\\u000b is a soft line break).",
  }),
  style: z.string().optional().describe("Name of a `styles` preset (its run fields apply)."),
  link: z.string().url().optional(),
  ...runFields,
});

const namedRoles = [
  "NORMAL_TEXT",
  "TITLE",
  "SUBTITLE",
  "HEADING_1",
  "HEADING_2",
  "HEADING_3",
  "HEADING_4",
  "HEADING_5",
  "HEADING_6",
] as const;

/** Content shared by paragraph and heading blocks: `text` (one run) or `runs`. */
const textContent = {
  text: z.string().optional().describe("Shorthand for one run."),
  runs: z.array(runSchema).optional(),
  style: z.string().optional().describe("Name of a `styles` preset (paragraph and run fields)."),
  ...paragraphFields,
  ...runFields,
};

export const paragraphBlockSchema = z.object({
  type: z.literal("paragraph"),
  role: z.enum(namedRoles).optional().describe("Named style (heading role). Default NORMAL_TEXT."),
  ...textContent,
});

export const headingBlockSchema = z.object({
  type: z.literal("heading"),
  level: z.union([z.number().int().min(1).max(6), z.literal("title"), z.literal("subtitle")]),
  ...textContent,
});

/** A list item: a string, or a paragraph-like object. */
const listItemSchema = z.union([
  z.string(),
  z.object({ text: z.string().optional(), runs: z.array(runSchema).optional(), style: z.string().optional(), ...paragraphFields, ...runFields }),
]);

export const listBlockSchema = z.object({
  type: z.literal("list"),
  ordered: z.boolean().optional().describe("true = numbered (1, a, i), false/omitted = bullets."),
  preset: z
    .enum([
      "BULLET_DISC_CIRCLE_SQUARE",
      "BULLET_DIAMONDX_ARROW3D_SQUARE",
      "BULLET_CHECKBOX",
      "BULLET_ARROW_DIAMOND_DISC",
      "BULLET_STAR_CIRCLE_SQUARE",
      "BULLET_ARROW3D_CIRCLE_SQUARE",
      "BULLET_LEFTTRIANGLE_DIAMOND_DISC",
      "NUMBERED_DECIMAL_ALPHA_ROMAN",
      "NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS",
      "NUMBERED_DECIMAL_NESTED",
      "NUMBERED_UPPERALPHA_ALPHA_ROMAN",
      "NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL",
      "NUMBERED_ZERODECIMAL_ALPHA_ROMAN",
    ])
    .optional()
    .describe("Exact Docs bullet preset; overrides `ordered`. Never type list markers into the text."),
  items: z.array(listItemSchema).min(1),
  style: z.string().optional().describe("Preset applied to every item."),
  ...paragraphFields,
  ...runFields,
});

export const spacerBlockSchema = z.object({
  type: z.literal("spacer"),
  height: z.number().positive().max(200).default(6).describe("Points (an empty paragraph of this font size, single spacing)."),
});

export const pageBreakBlockSchema = z.object({ type: z.literal("pageBreak") });

/** Blocks allowed inside a table cell. */
export const cellBlockSchema = z.discriminatedUnion("type", [
  paragraphBlockSchema,
  headingBlockSchema,
  listBlockSchema,
  spacerBlockSchema,
]);

/** Cell padding: one number for all sides, or per side. */
const paddingSchema = z.union([pt, z.object({ top: pt.optional(), bottom: pt.optional(), left: pt.optional(), right: pt.optional() })]);

/** Cell borders: "none", one border for all sides, or per side. */
const cellBorderSchema = z.object({ width: pt.default(1), color: color.default("#000000"), dash: z.enum(["SOLID", "DOT", "DASH"]).default("SOLID") });
const bordersSchema = z.union([
  z.literal("none"),
  cellBorderSchema,
  z.object({
    top: z.union([z.literal("none"), cellBorderSchema]).optional(),
    bottom: z.union([z.literal("none"), cellBorderSchema]).optional(),
    left: z.union([z.literal("none"), cellBorderSchema]).optional(),
    right: z.union([z.literal("none"), cellBorderSchema]).optional(),
  }),
]);

/** Cell look, settable per table (`cell` defaults) or per cell. */
const cellStyleFields = {
  background: color.optional(),
  padding: paddingSchema.optional(),
  borders: bordersSchema.optional().describe('"none" for a layout table, or { width, color }.'),
  valign: z.enum(["top", "middle", "bottom"]).optional(),
};

export const cellSchema = z.object({
  blocks: z.array(cellBlockSchema).default([]),
  ...cellStyleFields,
});

export const tableBlockSchema = z.object({
  type: z.literal("table"),
  columns: z
    .union([z.number().int().min(1).max(20), z.array(z.object({ width: pt.optional().describe("Fixed width in points; omit to share the rest evenly.") })).min(1).max(20)])
    .describe("Column count, or one entry per column with an optional fixed width."),
  rows: z
    .array(z.object({ cells: z.array(cellSchema).min(1), minHeight: pt.optional() }))
    .min(1),
  cell: z.object(cellStyleFields).optional().describe("Defaults for every cell (each cell may override)."),
  header: z
    .object(cellStyleFields)
    .extend(runFields)
    .optional()
    .describe("Cell + text defaults for the first row (a data table's header)."),
  gapBefore: z
    .number()
    .positive()
    .max(72)
    .optional()
    .describe("Size (pt) of the empty paragraph Google requires before a table that follows another table or starts the document. Default 1."),
});

export const blockSchema = z.discriminatedUnion("type", [
  paragraphBlockSchema,
  headingBlockSchema,
  listBlockSchema,
  spacerBlockSchema,
  pageBreakBlockSchema,
  tableBlockSchema,
]);

/** A preset: paragraph and run fields under one name. */
const presetSchema = z.object({ role: z.enum(namedRoles).optional(), ...paragraphFields, ...runFields });

export const documentSchema = z.object({
  pageMode: z.enum(["PAGES", "PAGELESS"]).optional().describe("Use PAGES when page layout matters."),
  margins: z.object({ top: pt.optional(), bottom: pt.optional(), left: pt.optional(), right: pt.optional() }).optional(),
  pageSize: z.union([z.enum(["LETTER", "LEGAL", "A4", "A5", "TABLOID"]), z.object({ width: z.number().positive(), height: z.number().positive() })]).optional(),
  landscape: z.boolean().optional(),
  bodyFont: font.optional(),
  bodySize: z.number().positive().optional(),
  bodyColor: color.optional(),
  lineSpacing: z.number().min(50).max(500).optional().describe("Default paragraph line spacing, percent."),
  maxPages: z.number().int().positive().optional().describe("A limit: the render check reports a finding when the build has more pages."),
  trailingGap: z
    .number()
    .positive()
    .max(72)
    .optional()
    .describe("Size (pt) of the empty paragraph Google keeps after a table that ends the document. Default 1."),
});

export const themeSchema = z.object({
  colors: z.record(z.string(), z.string().regex(HEX, "theme colors must be #RGB or #RRGGBB")).default({}),
  fonts: z.record(z.string(), z.string().min(1)).default({}),
});

/** Every color-valued key in the spec (checked against theme tokens). */
const COLOR_KEYS = new Set(["color", "highlight", "shading", "background", "bodyColor"]);
/** Every font-valued key in the spec. */
const FONT_KEYS = new Set(["font", "bodyFont"]);

/**
 * Check every color/font token and preset reference in a parsed spec.
 *
 * @param value - spec subtree
 * @param path - Zod path of `value`
 * @param theme - parsed theme
 * @param presets - preset names
 * @param ctx - Zod refinement context (issues are added here)
 * @returns nothing
 */
function checkRefs(
  value: unknown,
  path: (string | number)[],
  theme: { colors: Record<string, string>; fonts: Record<string, string> },
  presets: Set<string>,
  ctx: z.RefinementCtx,
): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkRefs(v, [...path, i], theme, presets, ctx));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const at = [...path, key];
    if (typeof v === "string" && COLOR_KEYS.has(key) && !HEX.test(v) && !(v in theme.colors)) {
      ctx.addIssue({ code: "custom", path: at, message: `Unknown color "${v}": use #RRGGBB or a theme.colors token (${Object.keys(theme.colors).join(", ") || "none defined"}).` });
    } else if (typeof v === "string" && FONT_KEYS.has(key) && !(v in theme.fonts) && !/^[A-Za-z0-9 ]+$/.test(v)) {
      ctx.addIssue({ code: "custom", path: at, message: `Font "${v}" is neither a theme.fonts token nor a font family name.` });
    } else if (typeof v === "string" && key === "style" && !presets.has(v)) {
      ctx.addIssue({ code: "custom", path: at, message: `Unknown style preset "${v}" (defined: ${[...presets].join(", ") || "none"}).` });
    } else if (v && typeof v === "object" && key !== "theme") {
      checkRefs(v, at, theme, presets, ctx);
    }
  }
}

/** The whole spec. */
export const layoutSpecSchema = z
  .object({
    document: documentSchema.default({}),
    theme: themeSchema.default({ colors: {}, fonts: {} }),
    styles: z.record(z.string(), presetSchema).default({}),
    blocks: z.array(blockSchema).min(1),
  })
  .superRefine((spec, ctx) => {
    const presets = new Set(Object.keys(spec.styles));
    checkRefs({ document: spec.document, styles: spec.styles, blocks: spec.blocks }, [], spec.theme, presets, ctx);
  });

export type LayoutSpec = z.output<typeof layoutSpecSchema>;
export type LayoutSpecInput = z.input<typeof layoutSpecSchema>;
export type Block = z.output<typeof blockSchema>;
export type CellBlock = z.output<typeof cellBlockSchema>;
export type TableBlock = z.output<typeof tableBlockSchema>;
export type Run = z.output<typeof runSchema>;
export type Preset = z.output<typeof presetSchema>;
