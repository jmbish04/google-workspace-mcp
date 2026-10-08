/**
 * @fileoverview `docs_build_from_spec`: the agent describes a designed
 * document as a layout spec; the server writes ONE guarded batch.
 *
 * Flow: read the document → pick the insert point (`create`: the tab must be
 * empty; `insert`: right after an anchor paragraph) → compile the spec
 * (`docs/spec/compile.ts`) → send it pinned to the revision that was read
 * (`writeControl.requiredRevisionId`) → read again and check that the text
 * before and after the insert is unchanged (insert mode).
 *
 * Page setup from `spec.document` (page mode, margins, size) is applied only
 * in `create` mode: an insert must not change an existing document's layout.
 *
 * `table_factory` is the same pipeline for one data table appended at the end
 * of a tab (`docs/table-spec.ts` builds its spec).
 *
 * Spread into `TOOLS` through `docs-engine-tools.ts`.
 *
 * @example
 * ```typescript
 * const doc = await tools.docs_create({ title: "Resume" });
 * const out = await tools.docs_build_from_spec({ documentId: doc.documentId, mode: "create", spec });
 * // → { ok: true, revisionId, requestCount: 181, layout: { tables: 3, paragraphs: 72, end: 2387 }, … }
 * ```
 */
import { z } from "zod";

import { runBatch } from "@/backend/docs/batch-runner";
import { resolveTabId } from "@/backend/docs/doc-summary";
import { docBodyContent } from "@/backend/docs/locate";
import { appendInsertPoint, bodyEnd, emptyBodyInsertPoint, resolveAnchor, textBetween, type InsertPoint } from "@/backend/docs/spec/anchor";
import { compileSpec } from "@/backend/docs/spec/compile";
import { layoutSpecSchema } from "@/backend/docs/spec/schema";
import { buildTableFactorySpec } from "@/backend/docs/table-spec";
import { DocsService } from "@/backend/mcp/services/docs";
import { acct, asUser } from "@/backend/mcp/tool-common";
import type { ToolDef } from "@/backend/mcp/tools";

/** Anchor input for insert mode. */
export const anchorSchema = z
  .object({
    heading: z.string().optional().describe("Text of a heading/title paragraph (case-insensitive)."),
    text: z.string().optional().describe("Literal text inside the anchor paragraph."),
    instance: z.number().int().min(1).optional().describe("1-based occurrence. Default 1."),
  })
  .describe("Top-level paragraph to insert after (table cells are not searched).");

/** The spec-driven Docs tools. */
export const docsSpecTools: ToolDef[] = [
  {
    name: "docs_build_from_spec",
    description:
      "Build a DESIGNED Google Doc (resume, report, one-pager, letterhead) from a declarative layout spec — the server computes every index and writes ONE guarded documents.batchUpdate (about 180 requests for a 1-page 2-column resume). Spec: { document: { pageMode: PAGES|PAGELESS, margins, pageSize, bodyFont, bodySize, bodyColor, lineSpacing (percent), maxPages, trailingGap }, theme: { colors: { ink: '#16253b', accent: … }, fonts: { heading: 'Montserrat', body: 'Lato' } }, styles: { <preset>: paragraph+run fields }, blocks: [ paragraph {text|runs:[{text, font, size, bold, italic, color, highlight, link, style}], role, align, lineSpacing, spaceAbove, spaceBelow, keepWithNext, borderBottom:{width,color,padding}, indentStart, indentFirstLine, shading, style} | heading {level 1-6|title|subtitle, …} | list {items, ordered|preset, …} | spacer {height} | pageBreak | table {columns: n | [{width}], rows:[{cells:[{blocks, background, padding, borders:'none'|{width,color}, valign}], minHeight}], cell:{defaults}, header:{first-row defaults}, gapBefore} ] }. Colors/fonts take theme token names; sizes and spacing are points. Use borderless tables for multi-column layout. mode 'create' (default) needs an EMPTY tab (e.g. right after docs_create) and applies document page setup; mode 'insert' puts the blocks right after an anchor paragraph ({ heading } or { text }) and leaves the rest of the doc unchanged (checked by a re-read: preserved {before, after}). dryRun:true returns the compiled requests without writing. Returns { ok, documentId, tabId, mode, insertAt, revisionId, requestCount, stats, layout: { tables, paragraphs, end }, preserved?, notes } or a typed batch failure (REVISION_CONFLICT if the doc changed after the read — nothing is written). See docs_schema recipes for complete working specs. Acts as the signed-in account; as_user overrides.",
    inputSchema: z.object({
      documentId: z.string(),
      tabId: z.string().optional().describe("Target tab; omit for the first tab."),
      mode: z.enum(["create", "insert"]).optional().describe("create (default): empty tab only. insert: after `anchor`."),
      anchor: anchorSchema.optional(),
      spec: layoutSpecSchema,
      dryRun: z.boolean().optional().describe("Compile and return the requests; write nothing."),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const docs = new DocsService(env, acct(sub, a));
      const mode: "create" | "insert" = a.mode ?? "create";
      const raw = await docs.getRaw<any>(a.documentId);
      const tabId = resolveTabId(raw, a.tabId);
      const content = docBodyContent(raw, tabId ?? undefined);
      const notes: string[] = [];

      let point: InsertPoint;
      if (mode === "create") point = emptyBodyInsertPoint(content);
      else {
        if (!a.anchor) throw new Error('mode "insert" needs an anchor: { heading } or { text }.');
        point = resolveAnchor(content, a.anchor, tabId);
      }
      const hasSetup = Boolean(a.spec.document?.pageMode || a.spec.document?.margins || a.spec.document?.pageSize || a.spec.document?.landscape !== undefined);
      if (mode === "insert" && hasSetup) notes.push("document page setup (page mode, margins, size) is applied only in create mode; it was ignored.");

      const compiled = compileSpec(a.spec, { insertAt: point.insertAt, tabId, trailing: point.trailing, pageSetup: mode === "create" });
      const requests = [...point.prefix, ...compiled.requests];
      const summary = {
        documentId: a.documentId,
        tabId,
        mode,
        insertAt: point.insertAt,
        anchor: point.anchor,
        requestCount: requests.length,
        stats: compiled.stats,
        layout: { tables: compiled.layout.tables.length, paragraphs: compiled.layout.paragraphs.length, end: compiled.layout.end },
      };
      if (a.dryRun) return { result: { ok: true, dryRun: true, ...summary, requests, notes } };

      const out = await runBatch(docs, a.documentId, requests, raw?.revisionId ? { requiredRevisionId: raw.revisionId } : undefined);
      if (!out.ok) return { result: out };

      const after = await docs.getRaw<any>(a.documentId);
      const afterContent = docBodyContent(after, tabId ?? undefined);
      let preserved: { before: boolean; after: boolean } | undefined;
      if (mode === "insert") {
        const added = compiled.insertedLength + point.prefix.length;
        const oldEnd = bodyEnd(content);
        const newEnd = bodyEnd(afterContent);
        preserved = {
          before: textBetween(content, 0, point.insertAt) === textBetween(afterContent, 0, point.insertAt),
          after: textBetween(content, point.insertAt, oldEnd) === textBetween(afterContent, point.insertAt + added, newEnd),
        };
        if (!preserved.before || !preserved.after) {
          notes.push("Text outside the inserted range differs after the write — check version history; another edit may have landed at the same time.");
        }
      }
      return {
        result: {
          ok: true,
          ...summary,
          revisionId: after?.revisionId ?? out.revisionId,
          ...(preserved ? { preserved } : {}),
          url: `https://docs.google.com/document/d/${a.documentId}/edit`,
          notes,
        },
        asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { specBuild: mode, requests: requests.length } },
      };
    },
  },
  {
    name: "table_factory",
    description:
      "Append a table to the END of a Google Doc tab from a 2D array of strings, in ONE guarded batchUpdate (built by the same compiler as docs_build_from_spec). Default look (theme 'default'): first row is a header with a dark-blue fill and white bold centered text, 1pt black borders. Options: header:false (no header row), borders:'none' (a layout table) or { width, color }, headerFill, headerColor, fills (per-cell colors, null = none, same shape as data), padding (pt), columnWidths (pt per column, null = share the rest), fontSize. Returns { ok, documentId, rows, cols, tableStart, revisionId, requestCount } or a typed batch failure. For a table inside a designed layout, use a table block in docs_build_from_spec instead. Acts as the signed-in account; as_user overrides.",
    inputSchema: z.object({
      documentId: z.string(),
      data: z.array(z.array(z.string())).min(1),
      theme: z.string().optional().describe("Only 'default' exists; the options below override it."),
      tabId: z.string().optional(),
      header: z.boolean().optional(),
      borders: z.union([z.literal("none"), z.object({ width: z.number().min(0).optional(), color: z.string().optional() })]).optional(),
      headerFill: z.string().optional(),
      headerColor: z.string().optional(),
      fills: z.array(z.array(z.string().nullable())).optional(),
      padding: z.number().min(0).optional(),
      columnWidths: z.array(z.number().positive().nullable()).optional(),
      fontSize: z.number().positive().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const docs = new DocsService(env, acct(sub, a));
      const raw = await docs.getRaw<any>(a.documentId);
      const tabId = resolveTabId(raw, a.tabId);
      const point = appendInsertPoint(docBodyContent(raw, tabId ?? undefined), tabId);
      const spec = buildTableFactorySpec(a.data, a);
      const compiled = compileSpec(spec, { insertAt: point.insertAt, tabId, trailing: point.trailing, pageSetup: false });
      const requests = [...point.prefix, ...compiled.requests];
      const out = await runBatch(docs, a.documentId, requests, raw?.revisionId ? { requiredRevisionId: raw.revisionId } : undefined);
      if (!out.ok) return { result: out };
      const table = compiled.layout.tables[0];
      return {
        result: {
          ok: true,
          documentId: a.documentId,
          tabId,
          rows: table.rows,
          cols: table.columns,
          tableStart: table.start,
          revisionId: out.revisionId,
          requestCount: requests.length,
        },
        asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { table: `${table.rows}x${table.columns}` } },
      };
    },
  },
];
