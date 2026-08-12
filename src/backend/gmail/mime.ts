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
 * Structure: multipart/mixed[ alternative(text,html) | text , ...attachments ]
 * when attachments exist; otherwise the alternative/plain body directly.
 */
export function buildRawMessage(o: BuildMessageOptions): string {
  const headers = headerLines(o);
  const altBoundary = `alt_${crypto.randomUUID()}`;

  if (o.attachments && o.attachments.length > 0) {
    const mixed = `mixed_${crypto.randomUUID()}`;
    const inner = bodyBlock(o, altBoundary);
    const parts: string[] = [
      `--${mixed}`,
      `Content-Type: ${inner.contentType}`,
      "",
      inner.body,
    ];
    for (const att of o.attachments) {
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

  const inner = bodyBlock(o, altBoundary);
  const mime = [...headers, `Content-Type: ${inner.contentType}`, "", inner.body].join("\r\n");
  return toBase64Url(mime);
}
