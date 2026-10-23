/**
 * @file gmail/outgoing-attachments.ts
 * @description Resolve outgoing email attachments the way Gmail does: attach as
 * real MIME parts when they fit, otherwise fall back to Google Drive links
 * shared "anyone with the link" plus a links section at the top of the body.
 *
 * A caller passes an `attachments[]` array; each item is ONE of:
 *   - `{ driveFileId }`                 attach the Drive file's bytes
 *   - `{ blob, filename, mimeType }`    attach an inline base64 file
 *   - `{ url, filename?, mimeType? }`   Worker fetches the bytes over https (SSRF-guarded, see ssrf-guard.ts)
 *   - `{ r2Key, filename?, mimeType? }` read the object from the R2_FILES_BUCKET binding
 *   - `{ driveFileId, as: "link" }`     do NOT attach — share + link it
 *
 * Exactly ONE source key per item (`driveFileId` | `blob` | `url` | `r2Key`).
 * Overflow / `as:"link"`: a `url` is linked AS-IS (no Drive copy); `blob` and `r2Key`
 * objects are uploaded to Drive and shared.
 *
 * Size policy: Gmail caps a message at 25 MiB and base64 inflates bytes ~1.33×,
 * so we track the CUMULATIVE ENCODED size and stop attaching before 25 MiB
 * (~18 MiB of raw bytes). Attachments are processed in order; the first one that
 * would push the encoded total over the cap — and every later one — falls back
 * to a Drive link instead of failing. A per-attachment report records how each
 * one was delivered.
 */
import { DriveService } from "@/backend/mcp/services/drive";
import { assertPublicHttpsUrl, fetchPublicHttps, FetchTooLargeError, MAX_URL_FETCH_BYTES, type FetchPublicOptions } from "@/backend/gmail/ssrf-guard";
import type { MimeAttachment } from "./mime";

/** Gmail's message ceiling in ENCODED (base64) bytes — 35 MiB, matching the /upload/gmail/v1 max the send/draft transport uploads through (see upload-transport.ts). */
export const GMAIL_MESSAGE_LIMIT = 35 * 1024 * 1024;

/**
 * One attachment request. `as:"inline"` embeds an image in the body via a
 * `Content-ID` (provide `contentId` and reference it in the HTML as
 * `<img src="cid:contentId">`); inline items always attach (never link-fallback).
 */
export type AttachmentSpec =
  | { driveFileId: string; as?: "attach" | "link" | "inline"; contentId?: string }
  | { blob: string; filename: string; mimeType?: string; as?: "attach" | "link" | "inline"; contentId?: string }
  | { url: string; filename?: string; mimeType?: string; as?: "attach" | "link" | "inline"; contentId?: string }
  | { r2Key: string; filename?: string; mimeType?: string; as?: "attach" | "link" | "inline"; contentId?: string };

/** Legacy inline-blob shape (the `blobs[]` tool param). */
export interface BlobInput {
  filename: string;
  mimeType?: string;
  contentBase64: string;
}

export interface AttachLink {
  name: string;
  url: string;
}

/** How a single attachment was ultimately delivered. */
export interface AttachmentReportItem {
  filename: string;
  source: "drive" | "blob" | "url" | "r2";
  ref?: string;
  bytes: number;
  disposition: "attached" | "linked-by-request" | "linked-over-limit";
  url?: string;
}

export interface ResolvedAttachments {
  attachments: MimeAttachment[];
  links: AttachLink[];
  report: AttachmentReportItem[];
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Encoded byte cost of `n` raw bytes in a MIME message: base64 (4 chars / 3
 * bytes, padded) PLUS the CRLF added every 76 chars (~+2.6%) PLUS a fixed slack
 * for the part's MIME headers + boundary. Overcounting slightly is the safe
 * direction — it keeps the real message under Gmail's 25 MiB cap at the boundary.
 */
function encodedSize(rawBytes: number): number {
  const b64 = Math.ceil(rawBytes / 3) * 4;
  const crlf = Math.ceil(b64 / 76) * 2;
  return b64 + crlf + 256;
}

/** Last non-empty path segment of a URL or R2 key, decoded; falls back to "attachment". */
function nameFromPath(path: string): string {
  const seg = path.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(seg) || "attachment";
  } catch {
    return seg || "attachment";
  }
}

function viewUrl(id: string, webViewLink?: string): string {
  return webViewLink ?? `https://drive.google.com/file/d/${id}/view`;
}

/**
 * Decide attach-vs-link per item (in order, honoring the cumulative encoded
 * budget) and produce MIME attachments + shared Drive links + a report.
 *
 * @param accountRef - the SENDING account's token ref (owns blob uploads + link shares)
 */
export async function resolveAttachments(
  env: Env,
  accountRef: string,
  specs: AttachmentSpec[],
  /** Raw byte size of the message body (html+text) — counts against the same 25 MiB cap. */
  bodyRawBytes = 0,
  /** Test seams for the `{ url }` source (DNS resolver / fetch). Production passes nothing. */
  urlFetchOpts: FetchPublicOptions = {},
): Promise<ResolvedAttachments> {
  const drive = new DriveService(env, accountRef);
  const attachments: MimeAttachment[] = [];
  const links: AttachLink[] = [];
  const report: AttachmentReportItem[] = [];
  // Seed the running total with the body's encoded cost so attachments can't
  // push the whole message over the cap.
  let usedEncoded = encodedSize(bodyRawBytes);

  /** Share a Drive file anyone-with-link (reader) and record a link + report row. */
  const linkDriveFile = async (
    fileId: string,
    name: string,
    bytes: number,
    disposition: "linked-by-request" | "linked-over-limit",
    webViewLink?: string,
  ): Promise<void> => {
    await drive.share(fileId, "reader", "anyone").catch(() => {});
    const url = viewUrl(fileId, webViewLink);
    links.push({ name, url });
    report.push({ filename: name, source: "drive", ref: fileId, bytes, disposition, url });
  };

  // ponytail: inline images always attach (a cid: ref can't point at a Drive link)
  // and count toward the budget but don't trigger the over-limit fallback — a
  // giant inline image could push the message over 25 MiB; acceptable (rare).
  for (const spec of specs) {
    const inline = spec.as === "inline";
    const keys = (["driveFileId", "blob", "url", "r2Key"] as const).filter((k) => k in spec);
    if (keys.length !== 1) throw new Error(`attachment must have exactly one of driveFileId|blob|url|r2Key (got ${keys.join(",") || "none"})`);
    if ("driveFileId" in spec) {
      const meta = await drive.getContentMeta(spec.driveFileId);
      const enc = encodedSize(meta.size);
      if (spec.as === "link") {
        await linkDriveFile(spec.driveFileId, meta.name, meta.size, "linked-by-request", meta.webViewLink);
      } else if (inline || usedEncoded + enc <= GMAIL_MESSAGE_LIMIT) {
        const bytes = await drive.downloadBytes(spec.driveFileId);
        attachments.push({ filename: meta.name, mimeType: meta.mimeType, bytes, ...(inline ? { contentId: spec.contentId ?? crypto.randomUUID() } : {}) });
        usedEncoded += enc;
        report.push({ filename: meta.name, source: "drive", ref: spec.driveFileId, bytes: meta.size, disposition: "attached" });
      } else {
        await linkDriveFile(spec.driveFileId, meta.name, meta.size, "linked-over-limit", meta.webViewLink);
      }
      continue;
    }

    // Non-Drive sources (blob | url | r2Key) all reduce to bytes + name + mime + report fields,
    // then share the same budget / Drive-link-overflow logic below.
    let bytes: Uint8Array;
    let filename: string;
    let mimeType: string;
    let source: "blob" | "url" | "r2";
    let ref: string | undefined;
    if ("url" in spec) {
      const linkUrl = assertPublicHttpsUrl(spec.url).toString(); // scheme/host sanity even when only linked
      const linkName = spec.filename || nameFromPath(new URL(linkUrl).pathname);
      const linkAsIs = (disposition: "linked-by-request" | "linked-over-limit", size: number) => {
        links.push({ name: linkName, url: linkUrl });
        report.push({ filename: linkName, source: "url", ref: linkUrl, bytes: size, disposition, url: linkUrl });
      };
      if (!inline && spec.as === "link") {
        linkAsIs("linked-by-request", 0); // never fetched, so size is unknown
        continue;
      }
      // Stream no more than the remaining budget (raw ≈ 0.72 × encoded headroom); over it → link as-is.
      const rawBudget = Math.max(0, Math.floor((GMAIL_MESSAGE_LIMIT - usedEncoded) * 0.72));
      let got;
      try {
        got = await fetchPublicHttps(spec.url, { ...urlFetchOpts, maxBytes: Math.min(MAX_URL_FETCH_BYTES, inline ? MAX_URL_FETCH_BYTES : rawBudget) });
      } catch (e) {
        if (e instanceof FetchTooLargeError && !inline) {
          linkAsIs("linked-over-limit", 0);
          continue;
        }
        throw e;
      }
      bytes = got.bytes;
      filename = spec.filename || got.dispositionFilename || nameFromPath(new URL(got.finalUrl).pathname);
      mimeType = spec.mimeType || got.contentType || "application/octet-stream";
      source = "url";
      ref = got.finalUrl; // query/hash stripped — signed URLs must not leak into the attached-report
    } else if ("r2Key" in spec) {
      if (!spec.r2Key.trim()) throw new Error("attachment r2Key is empty");
      const obj = await env.R2_FILES_BUCKET.get(spec.r2Key);
      if (!obj) throw new Error(`attachment r2Key not found in R2_FILES_BUCKET: ${spec.r2Key}`);
      bytes = new Uint8Array(await obj.arrayBuffer());
      filename = spec.filename || nameFromPath(spec.r2Key);
      mimeType = spec.mimeType || obj.httpMetadata?.contentType || "application/octet-stream";
      source = "r2";
      ref = spec.r2Key;
    } else {
      bytes = base64ToBytes(spec.blob);
      filename = spec.filename;
      mimeType = spec.mimeType || "application/octet-stream";
      source = "blob";
    }
    const enc = encodedSize(bytes.length);
    if ("url" in spec && !inline && usedEncoded + enc > GMAIL_MESSAGE_LIMIT) {
      links.push({ name: filename, url: spec.url });
      report.push({ filename, source, ref: spec.url, bytes: bytes.length, disposition: "linked-over-limit", url: spec.url });
      continue;
    }
    if (!inline && (spec.as === "link" || usedEncoded + enc > GMAIL_MESSAGE_LIMIT)) {
      // Not in Drive — upload first, then share + link.
      const up = await drive.uploadBinary(filename, mimeType, bytes);
      await drive.share(up.id, "reader", "anyone").catch(() => {});
      const url = viewUrl(up.id, up.webViewLink);
      links.push({ name: filename, url });
      report.push({
        filename,
        source,
        ref: up.id,
        bytes: bytes.length,
        disposition: spec.as === "link" ? "linked-by-request" : "linked-over-limit",
        url,
      });
    } else {
      attachments.push({ filename, mimeType, bytes, ...(inline ? { contentId: spec.contentId ?? crypto.randomUUID() } : {}) });
      usedEncoded += enc;
      report.push({ filename, source, ...(ref ? { ref } : {}), bytes: bytes.length, disposition: "attached" });
    }
  }

  return { attachments, links, report };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

/** Inlined-HTML "shared via Drive" section prepended to the body for linked files. */
export function linksSectionHtml(links: AttachLink[]): string {
  const items = links
    .map((l) => `<li style="margin:4px 0;"><a href="${escapeHtml(l.url)}" style="color:#1a73e8;">${escapeHtml(l.name)}</a></li>`)
    .join("");
  return (
    `<div style="margin:0 0 16px;padding:12px 14px;border:1px solid #dadce0;border-radius:8px;background:#f8f9fa;">` +
    `<div style="font-weight:700;margin-bottom:6px;">Attachments (shared via Google Drive)</div>` +
    `<ul style="margin:0;padding-left:20px;">${items}</ul></div>`
  );
}

/** Plain-text "shared via Drive" section prepended to the body for linked files. */
export function linksSectionText(links: AttachLink[]): string {
  return `Attachments (Google Drive links):\n${links.map((l) => `- ${l.name}: ${l.url}`).join("\n")}\n\n`;
}

/** Normalize legacy `driveIds` / `blobs` params into the unified `attachments[]` shape. */
export function toAttachmentSpecs(input: {
  attachments?: AttachmentSpec[];
  driveIds?: string[];
  blobs?: { filename: string; mimeType?: string; contentBase64: string }[];
}): AttachmentSpec[] {
  const specs: AttachmentSpec[] = [...(input.attachments ?? [])];
  for (const id of input.driveIds ?? []) specs.push({ driveFileId: id });
  for (const b of input.blobs ?? []) specs.push({ blob: b.contentBase64, filename: b.filename, mimeType: b.mimeType });
  return specs;
}
