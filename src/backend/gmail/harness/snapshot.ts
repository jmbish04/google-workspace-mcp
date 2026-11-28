/**
 * @fileoverview Turn a Gmail `users.drafts.get?format=full` (or
 * `messages.get?format=full`) response into a {@link DraftSnapshot}: the html
 * and text/plain parts, the headers, and every MIME leaf with its Content-ID.
 *
 * Pure — no network — so the harness parser is unit-tested on its own.
 *
 * @example
 * ```typescript
 * import { snapshotFromGmail } from "@/backend/gmail/harness/snapshot";
 * const snap = snapshotFromGmail(await googleJson(env, sub, `${BASE}/drafts/${id}?format=full`));
 * ```
 */
import type { DraftSnapshot, SnapshotPart } from "@/backend/gmail/harness/checks";

/** The subset of a Gmail MessagePart the harness reads. */
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

/** The subset of a Gmail Draft / Message resource the harness reads. */
export interface GmailDraftResource {
  id?: string;
  message?: { id?: string; threadId?: string; payload?: GmailPart };
  threadId?: string;
  payload?: GmailPart;
}

function decodeBase64UrlUtf8(data: string): string {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function headerMap(part?: GmailPart): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of part?.headers ?? []) out[h.name.toLowerCase()] = h.value;
  return out;
}

/**
 * Flatten a stored Gmail message into the snapshot the checks read.
 *
 * @param res - a Draft (`{id, message:{payload}}`) or a Message (`{payload}`)
 * @returns html/text bodies (first leaf of each type), headers, MIME leaves
 */
export function snapshotFromGmail(res: GmailDraftResource): DraftSnapshot {
  const payload = res.message?.payload ?? res.payload;
  let html = "";
  let text = "";
  const parts: SnapshotPart[] = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    if (p.parts?.length) return p.parts.forEach(walk);
    const h = headerMap(p);
    const mimeType = (p.mimeType ?? "").toLowerCase();
    const isBody = !p.filename && !h["content-id"];
    if (isBody && mimeType === "text/html" && !html && p.body?.data) html = decodeBase64UrlUtf8(p.body.data);
    else if (isBody && mimeType === "text/plain" && !text && p.body?.data) text = decodeBase64UrlUtf8(p.body.data);
    const contentId = h["content-id"]?.replace(/^<|>$/g, "");
    parts.push({
      mimeType,
      ...(p.filename ? { filename: p.filename } : {}),
      ...(contentId ? { contentId } : {}),
      ...(h["content-disposition"] ? { disposition: h["content-disposition"].split(";")[0].trim().toLowerCase() } : {}),
    });
  };
  walk(payload);
  return {
    html,
    text,
    headers: headerMap(payload),
    parts,
    threadId: res.message?.threadId ?? res.threadId,
  };
}
