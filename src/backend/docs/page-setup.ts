/**
 * @fileoverview Build the `updateDocumentStyle` request that sets page mode,
 * margins and page size on one tab.
 *
 * Two rules come from a live check on a consumer doc (2026-10-08):
 * - `documentFormat.documentMode: "PAGES"` with `tabId` switches a pageless doc
 *   to pages.
 * - Margin updates only worked with `tabId` set on the request; without it
 *   Google answered with an internal error. So the request always names a tab.
 *
 * `fields` lists only the fields the caller set, never `"*"`: a `"*"` mask would
 * reset every other document style field (headers, page numbers, background)
 * to its default.
 *
 * @example
 * ```typescript
 * import { buildPageSetupRequest } from "@/backend/docs/page-setup";
 * const req = buildPageSetupRequest({ tabId: "t.0", documentMode: "PAGES", margins: { top: 36 } });
 * await docs.batchUpdate(id, [req]);
 * ```
 */

/** Named page sizes, in points (1 in = 72 pt). */
export const PAGE_SIZES = {
  LETTER: { width: 612, height: 792 },
  LEGAL: { width: 612, height: 1008 },
  A4: { width: 595.28, height: 841.89 },
  A5: { width: 419.53, height: 595.28 },
  TABLOID: { width: 792, height: 1224 },
} as const;

export type PageSizeName = keyof typeof PAGE_SIZES;

/** What a page setup call may set. Every field is optional; unset fields stay as they are. */
export interface PageSetup {
  documentMode?: "PAGES" | "PAGELESS";
  /** Margins in points. */
  margins?: { top?: number; bottom?: number; left?: number; right?: number };
  /** A named size, or a custom size in points. */
  pageSize?: PageSizeName | { width: number; height: number };
  /** Landscape: Google flips width and height for the section. */
  flipPageOrientation?: boolean;
}

const pt = (magnitude: number) => ({ magnitude, unit: "PT" });

/**
 * Whether a page setup sets anything at all.
 *
 * @param setup - the requested setup
 * @returns true when at least one field would be written
 */
export function hasPageSetup(setup: PageSetup): boolean {
  const m = setup.margins ?? {};
  return Boolean(
    setup.documentMode ||
      setup.pageSize ||
      setup.flipPageOrientation !== undefined ||
      [m.top, m.bottom, m.left, m.right].some((v) => v !== undefined),
  );
}

/**
 * Build one `updateDocumentStyle` request for a tab.
 *
 * @param setup - fields to set, plus the `tabId` the request targets
 * @returns the request object, with `fields` naming only the fields set
 * @throws Error when the setup sets nothing (an empty field mask is a Google 400)
 * @example
 * buildPageSetupRequest({ tabId: "t.0", margins: { left: 50 } })
 * // → { updateDocumentStyle: { tabId: "t.0", documentStyle: { marginLeft: {…} }, fields: "marginLeft" } }
 */
export function buildPageSetupRequest(setup: PageSetup & { tabId?: string | null }): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  const fields: string[] = [];
  if (setup.documentMode) {
    style.documentFormat = { documentMode: setup.documentMode };
    fields.push("documentFormat.documentMode");
  }
  const m = setup.margins ?? {};
  const sides: [keyof NonNullable<PageSetup["margins"]>, string][] = [
    ["top", "marginTop"],
    ["bottom", "marginBottom"],
    ["left", "marginLeft"],
    ["right", "marginRight"],
  ];
  for (const [side, field] of sides) {
    if (m[side] !== undefined) {
      style[field] = pt(m[side]!);
      fields.push(field);
    }
  }
  if (setup.pageSize) {
    const size = typeof setup.pageSize === "string" ? PAGE_SIZES[setup.pageSize] : setup.pageSize;
    style.pageSize = { width: pt(size.width), height: pt(size.height) };
    fields.push("pageSize");
  }
  if (setup.flipPageOrientation !== undefined) {
    style.flipPageOrientation = setup.flipPageOrientation;
    fields.push("flipPageOrientation");
  }
  if (!fields.length) throw new Error("Page setup sets nothing: pass documentMode, margins, pageSize or flipPageOrientation.");
  return {
    updateDocumentStyle: {
      ...(setup.tabId ? { tabId: setup.tabId } : {}),
      documentStyle: style,
      fields: fields.join(","),
    },
  };
}

/**
 * Read back the page setup a tab now has, in points.
 *
 * @param documentStyle - a raw `documentTab.documentStyle`
 * @returns page mode, margins and page size as plain numbers
 */
export function readPageSetup(documentStyle: any): {
  documentMode: string | null;
  margins: { top: number | null; bottom: number | null; left: number | null; right: number | null };
  pageSize: { width: number | null; height: number | null };
} {
  const mag = (v: any): number | null => (typeof v?.magnitude === "number" ? v.magnitude : null);
  return {
    documentMode: documentStyle?.documentFormat?.documentMode ?? null,
    margins: {
      top: mag(documentStyle?.marginTop),
      bottom: mag(documentStyle?.marginBottom),
      left: mag(documentStyle?.marginLeft),
      right: mag(documentStyle?.marginRight),
    },
    pageSize: { width: mag(documentStyle?.pageSize?.width), height: mag(documentStyle?.pageSize?.height) },
  };
}
