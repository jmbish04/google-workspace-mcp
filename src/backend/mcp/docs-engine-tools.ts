/**
 * @fileoverview The batch-first Google Docs engine tools.
 *
 * Every Docs write in this family goes through `documents.batchUpdate` via
 * {@link runBatch}, so it can be pinned to the revision the caller read
 * (`writeControl.requiredRevisionId`), reports the new revision id, and fails
 * with a typed, readable error (revision conflict, failing request index)
 * instead of a raw Google 400.
 *
 * Tools here:
 * - `docs_get_json` — the raw document, led by a small `summary`
 *   (revisionId, documentMode, flattened tabs).
 * - `docs_batch_update` — raw requests, with `writeControl` passed through.
 * - `docs_set_page_setup` — PAGES/PAGELESS, margins, page size on one tab.
 * - `docs_outline` — one entry per element with its range, style, bullet,
 *   table/cell and a text preview (`docs/outline.ts`).
 * - `docs_find` — every match of a literal string with its range, bold flag
 *   and suggestion flag (`docs/find.ts`).
 *
 * Registered in `TOOLS` (spread in from `tools.ts`); reachable in the code-mode
 * sandbox as `await tools.<name>(args)`.
 *
 * @example
 * ```typescript
 * const doc = await tools.docs_get_json({ documentId });
 * const out = await tools.docs_batch_update({
 *   documentId, requests, writeControl: { requiredRevisionId: doc.summary.revisionId },
 * });
 * if (!out.ok && out.code === "REVISION_CONFLICT") { … read again … }
 * ```
 */
import { z } from "zod";

import { runBatch } from "@/backend/docs/batch-runner";
import { findAll } from "@/backend/docs/find";
import { outlineDoc, outlineLines } from "@/backend/docs/outline";
import { resolveTabId, summarizeDoc } from "@/backend/docs/doc-summary";
import { buildPageSetupRequest, hasPageSetup, PAGE_SIZES, readPageSetup, type PageSetup } from "@/backend/docs/page-setup";
import { flattenTabs } from "@/backend/docs/locate";
import { DocsService } from "@/backend/mcp/services/docs";
import { acct, asUser } from "@/backend/mcp/tool-common";
import type { ToolDef } from "@/backend/mcp/tools";

/** Identity sentence shared by the engine tool descriptions. */
const IDENTITY = "Acts as the signed-in account; as_user overrides.";

/** `writeControl` input shared by the write tools. */
export const writeControlSchema = z
  .object({
    requiredRevisionId: z
      .string()
      .optional()
      .describe("Revision id from your read (summary.revisionId). Google rejects the batch if the document changed since."),
    targetRevisionId: z
      .string()
      .optional()
      .describe("Apply against this recent revision and merge with collaborator changes. Use instead of requiredRevisionId, not with it."),
    writeMode: z
      .enum(["EDIT", "SUGGEST"])
      .optional()
      .describe("SUGGEST applies the batch as suggestions (Google Developer Preview; Google may refuse it)."),
  })
  .refine((wc) => !(wc.requiredRevisionId && wc.targetRevisionId), {
    message: "Pass requiredRevisionId or targetRevisionId, not both.",
  });

const marginsSchema = z
  .object({
    top: z.number().min(0).optional(),
    bottom: z.number().min(0).optional(),
    left: z.number().min(0).optional(),
    right: z.number().min(0).optional(),
  })
  .describe("Margins in points (72 pt = 1 inch).");

const pageSizeSchema = z
  .union([
    z.enum(Object.keys(PAGE_SIZES) as [keyof typeof PAGE_SIZES, ...(keyof typeof PAGE_SIZES)[]]),
    z.object({ width: z.number().positive(), height: z.number().positive() }),
  ])
  .describe("LETTER | LEGAL | A4 | A5 | TABLOID, or { width, height } in points.");

/** Page setup input shared by docs_set_page_setup and the spec compiler. */
export const pageSetupFields = {
  documentMode: z
    .enum(["PAGES", "PAGELESS"])
    .optional()
    .describe("PAGES for page layout (margins, page breaks, page count). New consumer docs can start PAGELESS."),
  margins: marginsSchema.optional(),
  pageSize: pageSizeSchema.optional(),
  flipPageOrientation: z.boolean().optional().describe("true = landscape."),
};

/** The batch-first Docs engine tools (spread into `TOOLS`). */
export const docsEngineTools: ToolDef[] = [
  {
    name: "docs_get_json",
    description:
      "Return a Google Doc's raw structure JSON (documents.get, includeTabsContent=true), led by a small `summary` = { documentId, title, revisionId, documentMode (PAGES|PAGELESS), tabs:[{tabId,title,parentTabId,nestingLevel,documentMode}] } so you can guard a batch (writeControl.requiredRevisionId = summary.revisionId) and pick a tab without walking the JSON. The rest is the unchanged raw document (it is large: about 100 KB for a 1-page doc with 3 tables) — prefer docs_outline for positions. " +
      IDENTITY,
    inputSchema: z.object({ documentId: z.string(), ...asUser }),
    async run({ env, sub }, a) {
      const raw = await new DocsService(env, acct(sub, a)).getRaw<Record<string, unknown>>(a.documentId);
      return { result: { summary: summarizeDoc(raw), ...raw } };
    },
  },
  {
    name: "docs_batch_update",
    description:
      "Apply an array of native Google Docs API requests to a document atomically — the full grammar (text, styles, tables, borders, cell fills, page/section breaks, tabs via tabId, document style). For a designed document prefer docs_build_from_spec, which writes this batch for you. Guard the batch with writeControl.requiredRevisionId = the revisionId you read (docs_get_json/docs_outline summary): if the document changed, nothing is applied. Returns { ok:true, documentId, replies, revisionId (after the batch), requestCount } or a typed failure { ok:false, code: REVISION_CONFLICT | INVALID_REQUEST | UNKNOWN_REQUEST_TYPE | WRITE_MODE_REFUSED | GOOGLE_ERROR, message, googleMessage, requestIndex?, requestType? } — nothing is applied on failure. " +
      IDENTITY,
    inputSchema: z.object({
      documentId: z.string(),
      requests: z.array(z.record(z.string(), z.unknown())),
      writeControl: writeControlSchema.optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const docs = new DocsService(env, acct(sub, a));
      const result = await runBatch(docs, a.documentId, a.requests, a.writeControl);
      return {
        result,
        ...(result.ok
          ? { asset: { assetType: "doc", googleId: a.documentId, action: "modify" as const, detail: { requests: a.requests.length } } }
          : {}),
      };
    },
  },
  {
    name: "docs_set_page_setup",
    description:
      "Set page mode (PAGES | PAGELESS), margins, page size and orientation on one tab of a Google Doc — one guarded updateDocumentStyle whose field mask names only what you set (unset fields are kept). Switch a pageless doc to PAGES whenever page layout matters (resumes, reports, anything printed or exported to PDF). Omit tabId for the first tab. Returns { ok:true, tabId, revisionId, after: { documentMode, margins, pageSize } } read back from the document, or a typed batch failure. " +
      IDENTITY,
    inputSchema: z
      .object({
        documentId: z.string(),
        tabId: z.string().optional(),
        ...pageSetupFields,
        ...asUser,
      })
      .refine((a) => hasPageSetup(a as PageSetup), {
        message: "Set at least one of documentMode, margins, pageSize, flipPageOrientation.",
      }),
    async run({ env, sub }, a) {
      const docs = new DocsService(env, acct(sub, a));
      const raw = await docs.getRaw<any>(a.documentId);
      const tabId = resolveTabId(raw, a.tabId);
      const request = buildPageSetupRequest({ ...(a as PageSetup), tabId });
      const out = await runBatch(docs, a.documentId, [request], raw?.revisionId ? { requiredRevisionId: raw.revisionId } : undefined);
      if (!out.ok) return { result: out };
      const after = await docs.getRaw<any>(a.documentId);
      const tab = flattenTabs(after).find((t: any) => t?.tabProperties?.tabId === tabId);
      return {
        result: {
          ok: true,
          documentId: a.documentId,
          tabId,
          revisionId: after?.revisionId ?? out.revisionId,
          after: readPageSetup(tab?.documentTab?.documentStyle ?? after?.documentStyle),
        },
        asset: { assetType: "doc", googleId: a.documentId, action: "modify", detail: { pageSetup: true } },
      };
    },
  },
  {
    name: "docs_outline",
    description:
      "Positions you can trust, without walking the raw JSON: one entry per structural element of a Google Doc — { tabId, kind (paragraph|table|sectionBreak|tableOfContents), start, end, style (namedStyleType), bullet, table (number in the tab), cell [row,col] for content inside a table cell, rows/columns for a table, text (60-char preview; pending suggestions shown as [+inserted]/[-deleted], flagged suggestions:true) } — and each tab's body endIndex (insert at endIndex-1 at the latest). Led by `summary` { revisionId, documentMode, tabs } so you can guard the next batch. format:'lines' returns compact text lines instead (P start-end STYLE [•] [t<n> r<r>c<c>] \"text\"; T start-end table n RxC; END tabId endIndex). Omit tabId for every tab. " +
      IDENTITY,
    inputSchema: z.object({
      documentId: z.string(),
      tabId: z.string().optional(),
      format: z.enum(["items", "lines"]).optional().describe("items (default) or compact text lines."),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const raw = await new DocsService(env, acct(sub, a)).getRaw<any>(a.documentId);
      const outline = outlineDoc(raw, { tabId: a.tabId });
      const summary = summarizeDoc(raw);
      return { result: a.format === "lines" ? { summary, lines: outlineLines(outline) } : { summary, ...outline } };
    },
  },
  {
    name: "docs_find",
    description:
      "Every match of a literal string in a Google Doc with its exact UTF-16 range: { matches: [{ tabId, startIndex, endIndex, text, bold (true|false|'mixed'), inSuggestion (pending tracked change on the matched text — do not edit it, ask the user to resolve it), table?, cell? [row,col] }], count, summary }. A match never crosses a non-text element (footnote, image, chip) or a cell boundary. matchCase defaults to true. Omit tabId to search every tab (nested tabs included). Headers and footers are not searched. Use the ranges in a docs_batch_update guarded with summary.revisionId. " +
      IDENTITY,
    inputSchema: z.object({
      documentId: z.string(),
      text: z.string().min(1),
      matchCase: z.boolean().optional(),
      tabId: z.string().optional(),
      ...asUser,
    }),
    async run({ env, sub }, a) {
      const raw = await new DocsService(env, acct(sub, a)).getRaw<any>(a.documentId);
      const matches = findAll(raw, a.text, { matchCase: a.matchCase ?? true, tabId: a.tabId });
      return { result: { summary: summarizeDoc(raw), count: matches.length, matches } };
    },
  },
];
