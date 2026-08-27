/**
 * @file docs/doc-preview.ts
 * @description Turn a Drive-exportable file (Doc/Sheet/Slides/PDF) into a
 * per-page visual preview the model can SEE: export to PDF, rasterize EACH page
 * to a PNG (Browser Rendering), stash the PDF + every page image on R2 (served
 * at /api/preview/:id, auto-expired after 48h), and — by default — ask an Ollama
 * vision model to critique each page's formatting.
 *
 * Returns `{ pdf_url, pages: { pg_1: { image_url, vision_ai_notes }, ... }, meta }`.
 * Best-effort end to end: a page with no rasterizer is skipped, and a missing
 * Guardian route just omits `vision_ai_notes` — the create/preview that called
 * this never fails because of it.
 */
import { getDocumentProxy } from "unpdf";

import type { DriveService } from "@/backend/mcp/services/drive";
import { rasterizePdfPage } from "./browser-render";
import { putPreview } from "./preview-store";
import { critiquePageImage } from "./vision-critique";

export interface PagePreview {
  image_url: string;
  /** Ollama formatting critique — omitted when the vision route is unavailable. */
  vision_ai_notes?: string;
}

export interface DocPreview {
  /** Servable URL of the exported PDF (R2, 48h TTL). */
  pdf_url: string;
  /** { pg_1: {...}, pg_2: {...} } — one entry per rendered page. */
  pages: Record<string, PagePreview>;
  meta: { pageCount: number; rendered: number; truncated: boolean; critique: boolean };
}

/** Default cap on pages rendered — each page is a Browser-Rendering call (+ a vision call). */
export const DEFAULT_MAX_PREVIEW_PAGES = 5;

/**
 * Build a per-page preview for `fileId`.
 *
 * @param opts.maxPages  cap on pages rendered (default {@link DEFAULT_MAX_PREVIEW_PAGES})
 * @param opts.critique  run the Ollama formatting critique per page (default true)
 * @param opts.sub       acting user sub (unused for storage; kept for parity/logging)
 */
export async function buildDocPreview(
  env: Env,
  drive: DriveService,
  fileId: string,
  opts: { maxPages?: number; critique?: boolean; sub?: string } = {},
): Promise<DocPreview | null> {
  const critique = opts.critique !== false;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PREVIEW_PAGES;

  let pdf: Uint8Array;
  try {
    pdf = await drive.exportBinary(fileId, "application/pdf");
  } catch {
    return null;
  }

  // Stash the PDF itself (best-effort) so the model can pull the source too.
  const runId = crypto.randomUUID();
  let pdfUrl = "";
  try {
    pdfUrl = await putPreview(env, `${runId}.pdf`, pdf, "application/pdf");
  } catch {
    pdfUrl = "";
  }

  let total: number;
  try {
    total = (await getDocumentProxy(pdf)).numPages;
  } catch {
    total = 1;
  }
  const count = Math.min(total, maxPages);

  const pages: Record<string, PagePreview> = {};
  for (let p = 1; p <= count; p++) {
    // Guard the whole per-page pipeline (rasterize, R2 put, critique): one bad
    // page must never break the rest of the preview or the create above it.
    try {
      const png = await rasterizePdfPage(env, pdf, p);
      if (!png) continue; // Browser Rendering unavailable / page failed — skip it.

      const imageUrl = await putPreview(env, `${runId}-p${p}.png`, png, "image/png");
      const entry: PagePreview = { image_url: imageUrl };
      if (critique) {
        const notes = await critiquePageImage(env, png);
        if (notes) entry.vision_ai_notes = notes;
      }
      pages[`pg_${p}`] = entry;
    } catch {
      continue; // skip this page, keep going
    }
  }

  return {
    pdf_url: pdfUrl,
    pages,
    meta: { pageCount: total, rendered: Object.keys(pages).length, truncated: total > count, critique },
  };
}
