/**
 * @file gmail/build-outgoing.ts
 * @description One place that turns caller intent (text / html / markdown +
 * attachments) into a Gmail `raw` payload: inline + sanitize the HTML, resolve
 * attachments (attach vs Drive-link fallback, per-item and by size), prepend the
 * Drive-links section, then build the MIME. Returns the raw plus a per-attachment
 * delivery report.
 */
import { composeBody } from "./compose";
import { buildRawMessage } from "./mime";
import {
  resolveAttachments,
  toAttachmentSpecs,
  linksSectionHtml,
  linksSectionText,
  type AttachmentSpec,
  type AttachLink,
  type AttachmentReportItem,
} from "./outgoing-attachments";

export interface OutgoingOptions {
  to: string;
  from?: string;
  cc?: string;
  bcc?: string;
  subject: string;
  inReplyTo?: string;
  references?: string;
  /** Body — supply one of these (priority: markdown → html → text). */
  text?: string;
  html?: string;
  markdown?: string;
  /** Unified attachment specs (Drive files, blobs, or forced links). */
  attachments?: AttachmentSpec[];
  /** Legacy: Drive file ids to attach (mapped into `attachments`). */
  driveIds?: string[];
  /** Legacy: inline base64 blobs to attach (mapped into `attachments`). */
  blobs?: { filename: string; mimeType?: string; contentBase64: string }[];
  /**
   * Correlation id stamped into the body (`ref: …` trailing line in text, a
   * visually hidden line in HTML) and sent as `X-Colby-Ref`. Callers pass their
   * own (core-delegation sends its `CD-XXXXXX`); absent, a uuid is minted. It is
   * echoed back so the caller can store it, and Gmail search finds the thread
   * by it even after the subject is rewritten.
   */
  referenceId?: string;
}

export interface BuiltOutgoing {
  raw: string;
  /** The id stamped into this message (see OutgoingOptions.referenceId). */
  referenceId: string;
  /** Per-attachment delivery report (empty when no attachments requested). */
  attachmentReport: AttachmentReportItem[];
  /** Drive links used (empty when everything attached inline). */
  links: AttachLink[];
}

/** Build the base64url `raw` for send/draft, applying sanitize + styling + attachment policy. */
export async function buildOutgoingRaw(
  env: Env,
  accountRef: string,
  o: OutgoingOptions,
): Promise<BuiltOutgoing> {
  const specs = toAttachmentSpecs({ attachments: o.attachments, driveIds: o.driveIds, blobs: o.blobs });

  // Compose the body first so its size counts against the 25 MiB attachment cap.
  let { html, text } = composeBody({ text: o.text, html: o.html, markdown: o.markdown });
  const referenceId = o.referenceId?.trim() || crypto.randomUUID();
  ({ html, text } = stampReferenceId({ html, text }, referenceId));
  const bodyRawBytes = new TextEncoder().encode((html ?? "") + text).length;
  const resolved = await resolveAttachments(env, accountRef, specs, bodyRawBytes);

  if (resolved.links.length > 0) {
    // Prepend a "shared via Drive" section (Gmail auto-linkifies the plain-text urls).
    text = linksSectionText(resolved.links) + text;
    if (html) html = linksSectionHtml(resolved.links) + html;
  }

  const raw = buildRawMessage({
    to: o.to,
    from: o.from,
    cc: o.cc,
    bcc: o.bcc,
    subject: o.subject,
    inReplyTo: o.inReplyTo,
    references: o.references,
    text,
    html,
    attachments: resolved.attachments,
    extraHeaders: { "X-Colby-Ref": referenceId },
  });

  return { raw, referenceId, attachmentReport: resolved.report, links: resolved.links };
}

/**
 * Append the reference id to a composed body. Text gets a trailing `ref: …`
 * line (Gmail indexes it, so `"<id>"` in the search box finds every message in
 * the thread that quotes it). HTML gets the same line in a visually hidden div
 * placed before `</body>` when present, else at the end. Idempotent: a body
 * that already carries the id is returned unchanged.
 */
export function stampReferenceId(body: { html?: string; text: string }, referenceId: string): { html?: string; text: string } {
  const line = `ref: ${referenceId}`;
  const text = body.text.includes(line) ? body.text : `${body.text.replace(/\s+$/, "")}\n\n${line}\n`;
  let html = body.html;
  if (html && !html.includes(line)) {
    const hidden = `<div style="display:none;font-size:1px;line-height:1px;color:transparent;max-height:0;overflow:hidden" aria-hidden="true">${line}</div>`;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${hidden}</body>`) : `${html}${hidden}`;
  }
  return { html, text };
}
