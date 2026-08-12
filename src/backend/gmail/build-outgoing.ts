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
}

export interface BuiltOutgoing {
  raw: string;
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
  });

  return { raw, attachmentReport: resolved.report, links: resolved.links };
}
