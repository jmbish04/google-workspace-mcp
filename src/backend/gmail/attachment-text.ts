/**
 * @file gmail/attachment-text.ts
 * @description In-worker text extraction for attachment types that need no OCR
 * or Drive conversion: csv / tsv / txt / json / markdown (direct UTF-8 decode)
 * and `message/rfc822` forwarded mail (headers + body via {@link parseEml}).
 * PDFs/images stay in ocr-service and Office files in office-markdown; this
 * module only covers what those two cannot read. Pure, no network.
 */
import { formatEml, parseEml } from "@/backend/gmail/eml-parse";

/** Cap on decoded characters per attachment so a huge csv cannot blow the response. */
export const MAX_DIRECT_TEXT_CHARS = 200_000;

const TEXT_MIMES = new Set([
  "text/csv",
  "application/csv",
  "text/tab-separated-values",
  "text/plain",
  "application/json",
  "text/json",
  "text/markdown",
]);
const TEXT_EXT = /\.(csv|tsv|txt|json|md|log)$/i;
const EML_EXT = /\.eml$/i;

/** True when the attachment is a directly decodable text format. */
export function isDirectTextAttachment(mimeType: string, filename = ""): boolean {
  const m = mimeType.toLowerCase().split(";")[0].trim();
  if (TEXT_MIMES.has(m)) return true;
  // Gmail often labels csv/json as octet-stream; trust the extension then.
  return (m === "application/octet-stream" || m === "") && TEXT_EXT.test(filename);
}

/** True when the attachment is a forwarded email (`message/rfc822` or `.eml`). */
export function isEmlAttachment(mimeType: string, filename = ""): boolean {
  const m = mimeType.toLowerCase().split(";")[0].trim();
  return m === "message/rfc822" || (m === "application/octet-stream" && EML_EXT.test(filename));
}

/**
 * Decode a text attachment's bytes as UTF-8 (TextDecoder strips a BOM), truncated to
 * {@link MAX_DIRECT_TEXT_CHARS} with an explicit marker.
 */
export function decodeUtf8Text(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  if (text.length <= MAX_DIRECT_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_DIRECT_TEXT_CHARS)}\n[truncated: ${text.length.toLocaleString("en-US")} chars total]`;
}

/**
 * Extract `doc_text` for csv/txt/json and forwarded-eml attachments.
 *
 * @param bytes attachment bytes
 * @param mimeType attachment MIME type
 * @param filename attachment filename (extension fallback)
 * @returns the text, or null when this module does not handle the type
 *   (caller falls through to OCR / Office conversion)
 * @example extractDirectText(csvBytes, "text/csv", "a.csv")
 */
export function extractDirectText(bytes: Uint8Array, mimeType: string, filename = ""): string | null {
  if (isEmlAttachment(mimeType, filename)) return formatEml(parseEml(bytes));
  if (isDirectTextAttachment(mimeType, filename)) return decodeUtf8Text(bytes);
  return null;
}
