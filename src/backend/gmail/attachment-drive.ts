/**
 * @file gmail/attachment-drive.ts
 * @description Upload a Gmail message's (non-junk) attachments to the acting
 * account's Drive and extract their text, returning the compact attachment
 * objects the agent consumes.
 *
 * For each kept attachment: download the bytes, upload to the resolved thread
 * folder (or an explicit parent), compute a SHA-256 content hash, and extract
 * `doc_text` via the shared OCR/text pipeline (unpdf for PDFs, docling for
 * images when configured; empty string for formats we can't read on the edge).
 */
import { DriveService } from "@/backend/mcp/services/drive";
import type { GmailService } from "@/backend/mcp/services/gmail";

import { keepableAttachments } from "./attachments";
import { decodeAttachment, hashBytes } from "./attachment-store";
import { ocrAttachment } from "./ocr-service";
import { resolveThreadFolder } from "./threads-folder";

/** The attachment object returned to the agent alongside email content. */
export interface DriveAttachment {
  filename: string;
  driveId: string;
  driveUrl: string | null;
  mimetype: string;
  size: number;
  sha256_hash: string;
  doc_text: string;
}

/** Safe Drive file name (mirrors attachment-store's private helper). */
function safeName(s: string): string {
  return (s || "file").replace(/[^\w.-]+/g, "_").slice(0, 120);
}

/** Read the `Subject` header out of a raw Gmail message payload. */
export function subjectFromPayload(payload: unknown): string | null {
  const headers = (payload as { headers?: { name?: string; value?: string }[] } | null | undefined)?.headers;
  return headers?.find((h) => h?.name?.toLowerCase() === "subject")?.value ?? null;
}

/** Lowercase hex SHA-256 of the bytes (WebCrypto — available in Workers). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hard cap on attachments uploaded in a single call (subrequest budget). */
export const MAX_ATTACHMENTS_PER_CALL = 25;

export interface UploadOpts {
  messageId: string;
  /** The raw Gmail message `payload` (MIME tree with headers/parts). */
  payload: unknown;
  /** Thread subject — used to name the destination subfolder. */
  subject: string;
  /** Explicit destination folder; skips threads-root/subject resolution. */
  parentId?: string;
  /** Pre-resolved destination folder id (used to reuse one folder across a thread). */
  folderId?: string;
  gmail: GmailService;
}

/**
 * Upload a message's kept attachments to Drive and return their objects.
 * Returns `{ folderId, attachments }`; `folderId` is null when the message had
 * no keepable attachments (no folder was resolved/created).
 */
export async function uploadMessageAttachments(
  env: Env,
  ref: string,
  accountKey: string,
  opts: UploadOpts,
): Promise<{ folderId: string | null; attachments: DriveAttachment[] }> {
  const parts = keepableAttachments(opts.payload).slice(0, MAX_ATTACHMENTS_PER_CALL);
  if (!parts.length) return { folderId: null, attachments: [] };

  const folderId = opts.folderId ?? (await resolveThreadFolder(env, ref, accountKey, opts.subject, opts.parentId));
  const drive = new DriveService(env, ref);
  const attachments: DriveAttachment[] = [];

  for (const part of parts) {
    const bytes = decodeAttachment((await opts.gmail.getAttachment(opts.messageId, part.attachmentId)).data);
    const [sha256, file] = await Promise.all([
      sha256Hex(bytes),
      drive.uploadBinary(safeName(part.filename || part.attachmentId), part.mimeType, bytes, folderId),
    ]);

    let docText = "";
    try {
      // ocrAttachment dedups by MD5 against previously OCR'd bytes.
      docText = (await ocrAttachment(env, {
        bytes,
        mimeType: part.mimeType,
        hash: hashBytes(bytes),
        filename: part.filename || undefined,
      })) ?? "";
    } catch (err) {
      console.error(`[attachment-drive] text extract ${part.filename}:`, err instanceof Error ? err.message : err);
    }

    attachments.push({
      filename: part.filename || safeName(part.attachmentId),
      driveId: file.id,
      driveUrl: file.webViewLink ?? null,
      mimetype: part.mimeType,
      size: part.size,
      sha256_hash: sha256,
      doc_text: docText,
    });
  }

  return { folderId, attachments };
}
