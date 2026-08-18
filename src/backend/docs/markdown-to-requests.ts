/**
 * @file docs/markdown-to-requests.ts
 * @description Markdown → Google Docs batchUpdate requests. Thin wrapper: parse
 * the Markdown to HTML with `marked`, then reuse {@link htmlToRequests} for the
 * block/inline → Docs mapping. This is the APPEND path — it produces requests
 * that insert at `baseIndex` into an EXISTING doc (headings, bold/italic/
 * underline/inline-code, bullet/numbered lists).
 *
 * For creating a WHOLE new doc from Markdown, prefer Drive's native importer
 * (`DriveService.createDocFromMarkdown`) — higher fidelity (tables, images).
 * Tables/images are out of scope here, same ceiling as {@link htmlToRequests}.
 */
import { marked } from "marked";

import { htmlToRequests } from "./html-to-braille";

type DocsRequest = Record<string, unknown>;

/** Convert a Markdown string to Docs batchUpdate requests inserting at `baseIndex`. */
export function markdownToRequests(markdown: string, baseIndex = 1, tabId?: string): DocsRequest[] {
  // GFM on, no soft-break <br> (Docs paragraphs already break per block).
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
  return htmlToRequests(html, baseIndex, tabId);
}
