/**
 * @file gmail/mime.ts
 * @description Build an RFC822 message (with optional HTML alternative and file
 * attachments) and base64url-encode it for the Gmail API `raw` field. Workers-
 * native: Web `btoa`/`TextEncoder`, no Node `Buffer`.
 */

/** Encode a UTF-8 string to standard base64 (not url-safe), for MIME payloads. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64url-encode a full MIME string for Gmail's `raw` field. */
function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC2047-encode a header value when it carries non-ASCII (keeps subjects intact). */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(value))}?=`;
}

/** Wrap base64 into 76-char lines per MIME. */
function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /**
   * When set, the part is embedded INLINE (multipart/related, `Content-Disposition:
   * inline`, `Content-ID: <contentId>`) so the HTML body can render it via
   * `<img src="cid:contentId">`. Otherwise it's a regular file attachment.
   */
  contentId?: string;
}

export interface BuildMessageOptions {
  to: string;
  from?: string;
  cc?: string;
  bcc?: string;
  subject: string;
  inReplyTo?: string;
  references?: string;
  /** Plain-text body (always present as the text alternative / sole body). */
  text: string;
  /** Optional inlined-HTML body — produces a multipart/alternative. */
  html?: string;
  attachments?: MimeAttachment[];
}

function headerLines(o: BuildMessageOptions): string[] {
  const h = [`To: ${o.to}`];
  if (o.from) h.push(`From: ${o.from}`);
  if (o.cc) h.push(`Cc: ${o.cc}`);
  if (o.bcc) h.push(`Bcc: ${o.bcc}`);
  h.push(`Subject: ${encodeHeaderValue(o.subject)}`);
  if (o.inReplyTo) h.push(`In-Reply-To: ${o.inReplyTo}`);
  if (o.references) h.push(`References: ${o.references}`);
  h.push("MIME-Version: 1.0");
  return h;
}

/** text + optional html as a body block (no outer headers) — plain part or multipart/alternative. */
function bodyBlock(o: BuildMessageOptions, boundary: string): { contentType: string; body: string } {
  const textPart = ["Content-Type: text/plain; charset=UTF-8", "", o.text];
  if (!o.html) {
    return { contentType: "text/plain; charset=UTF-8", body: o.text };
  }
  const htmlPart = ["Content-Type: text/html; charset=UTF-8", "", o.html];
  const body = [
    `--${boundary}`,
    ...textPart,
    `--${boundary}`,
    ...htmlPart,
    `--${boundary}--`,
  ].join("\r\n");
  return { contentType: `multipart/alternative; boundary="${boundary}"`, body };
}

/**
 * Build the RFC822 message and base64url-encode it for Gmail's `raw` field.
 *
 * Nesting (only the layers that are needed appear):
 *   multipart/mixed[                       ← present iff there are file attachments
 *     multipart/related[                   ← present iff there are inline images
 *       multipart/alternative(text, html)  ← or a bare text part when no html
 *       ...inline image parts (Content-ID, inline)
 *     ]
 *     ...file attachment parts
 *   ]
 *
 * `Content-ID` inline parts let the HTML render `<img src="cid:contentId">`.
 */
export function buildRawMessage(o: BuildMessageOptions): string {
  const headers = headerLines(o);
  const altBoundary = `alt_${crypto.randomUUID()}`;
  const atts = o.attachments ?? [];
  const inlineImgs = atts.filter((a) => a.contentId);
  const files = atts.filter((a) => !a.contentId);

  const body = bodyBlock(o, altBoundary);

  // Content root = the body, wrapped in multipart/related when inline images exist.
  let rootContentType = body.contentType;
  let rootBody = body.body;
  if (inlineImgs.length > 0) {
    const rel = `rel_${crypto.randomUUID()}`;
    const parts: string[] = [`--${rel}`, `Content-Type: ${body.contentType}`, "", body.body];
    for (const img of inlineImgs) {
      parts.push(
        `--${rel}`,
        `Content-Type: ${img.mimeType}; name="${img.filename}"`,
        "Content-Transfer-Encoding: base64",
        `Content-ID: <${img.contentId}>`,
        `Content-Disposition: inline; filename="${img.filename}"`,
        "",
        wrap76(bytesToBase64(img.bytes)),
      );
    }
    parts.push(`--${rel}--`);
    rootContentType = `multipart/related; boundary="${rel}"`;
    rootBody = parts.join("\r\n");
  }

  // Wrap in multipart/mixed when there are regular file attachments.
  if (files.length > 0) {
    const mixed = `mixed_${crypto.randomUUID()}`;
    const parts: string[] = [`--${mixed}`, `Content-Type: ${rootContentType}`, "", rootBody];
    for (const att of files) {
      parts.push(
        `--${mixed}`,
        `Content-Type: ${att.mimeType}; name="${att.filename}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${att.filename}"`,
        "",
        wrap76(bytesToBase64(att.bytes)),
      );
    }
    parts.push(`--${mixed}--`);
    const mime = [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, "", parts.join("\r\n")].join("\r\n");
    return toBase64Url(mime);
  }

  const mime = [...headers, `Content-Type: ${rootContentType}`, "", rootBody].join("\r\n");
  return toBase64Url(mime);
}
