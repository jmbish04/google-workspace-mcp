/**
 * @file gmail/eml-parse.ts
 * @description Minimal, dependency-free RFC822 / `.eml` reader for forwarded
 * mail attached as `message/rfc822`. Pure, Workers-safe, no network.
 *
 * Handles header unfolding, RFC2047 encoded-words, multipart recursion,
 * base64 / quoted-printable transfer encodings and charset-labelled decoding.
 * It extracts only what a model needs from a forwarded message: the headers
 * and the readable body. Binary sub-attachments are listed by name, not decoded.
 */

/** Headers surfaced from an embedded message (lowercase keys, decoded values). */
export interface EmlHeaders {
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  subject?: string;
}

/** A parsed embedded message. */
export interface ParsedEml {
  headers: EmlHeaders;
  /** Readable body: text/plain preferred, tags-stripped text/html as fallback. */
  body: string;
  /** Filenames of nested attachments (not decoded). */
  attachmentNames: string[];
}

interface RawPart {
  headers: Map<string, string>;
  body: string;
}

/** Decode bytes to a string using a charset label, falling back to UTF-8. */
function decodeCharset(bytes: Uint8Array, charset?: string): string {
  try {
    return new TextDecoder(charset?.trim().toLowerCase() || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Latin-1 string (one char per byte) to bytes. */
function binaryToBytes(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
}

/** Decode a quoted-printable body (or Q-encoded word) to bytes. */
function qpToBytes(s: string, headerMode = false): Uint8Array {
  const t = (headerMode ? s.replace(/_/g, " ") : s.replace(/=\r?\n/g, "")).replace(
    /=([0-9A-Fa-f]{2})/g,
    (_m, h: string) => String.fromCharCode(parseInt(h, 16)),
  );
  return binaryToBytes(t);
}

/** Decode a base64 string to bytes (whitespace tolerant). */
function b64ToBytes(s: string): Uint8Array {
  return binaryToBytes(atob(s.replace(/\s+/g, "")));
}

/** Decode RFC2047 encoded-words (`=?utf-8?B?...?=`) in a header value. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, text: string) => {
      try {
        const bytes = enc.toLowerCase() === "b" ? b64ToBytes(text) : qpToBytes(text, true);
        return decodeCharset(bytes, cs);
      } catch {
        return text;
      }
    });
}

/** Split raw text into header map + body at the first blank line. */
function splitPart(raw: string): RawPart {
  const text = raw.replace(/\r\n/g, "\n");
  const idx = text.indexOf("\n\n");
  const head = idx === -1 ? text : text.slice(0, idx);
  const body = idx === -1 ? "" : text.slice(idx + 2);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
    const c = line.indexOf(":");
    if (c > 0) headers.set(line.slice(0, c).trim().toLowerCase(), line.slice(c + 1).trim());
  }
  return { headers, body };
}

/** Pull a `key=value` parameter out of a structured header (quotes stripped). */
function param(header: string | undefined, key: string): string | undefined {
  const m = header?.match(new RegExp(`${key}\\*?="?([^";]+)"?`, "i"));
  return m?.[1]?.trim();
}

/** Decode a leaf part's body per its transfer encoding + charset. */
function decodeLeaf(part: RawPart): string {
  const enc = (part.headers.get("content-transfer-encoding") ?? "").toLowerCase();
  const charset = param(part.headers.get("content-type"), "charset");
  if (enc === "base64") return decodeCharset(b64ToBytes(part.body), charset);
  if (enc === "quoted-printable") return decodeCharset(qpToBytes(part.body), charset);
  return part.body;
}

/** Strip tags from an HTML fallback body. */
function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Walk a part, collecting the first plain / html body and nested attachment names. */
function walk(part: RawPart, acc: { plain: string; html: string; names: string[] }): void {
  const ctype = part.headers.get("content-type") ?? "text/plain";
  const mime = ctype.split(";")[0].trim().toLowerCase();
  const boundary = param(ctype, "boundary");
  if (mime.startsWith("multipart/") && boundary) {
    const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const chunks = part.body.split(new RegExp(`^--${esc}(?:--)?[ \\t]*$`, "m")).slice(1);
    for (const chunk of chunks) {
      const trimmed = chunk.replace(/^\n/, "");
      if (trimmed.trim()) walk(splitPart(trimmed), acc);
    }
    return;
  }
  const name =
    param(part.headers.get("content-disposition"), "filename") ?? param(ctype, "name");
  if (name) {
    acc.names.push(decodeEncodedWords(name));
    return;
  }
  if (mime === "text/plain" && !acc.plain) acc.plain = decodeLeaf(part).trim();
  else if (mime === "text/html" && !acc.html) acc.html = decodeLeaf(part);
}

/**
 * Parse the bytes of a `message/rfc822` attachment into headers + readable body.
 *
 * @param bytes raw RFC822 message bytes
 * @returns headers (From/To/Cc/Date/Subject), body text and nested attachment names
 * @example parseEml(bytes).headers.subject
 */
export function parseEml(bytes: Uint8Array): ParsedEml {
  const root = splitPart(new TextDecoder("latin1").decode(bytes));
  const get = (k: string) => {
    const v = root.headers.get(k);
    return v ? decodeEncodedWords(v) : undefined;
  };
  const acc = { plain: "", html: "", names: [] as string[] };
  walk(root, acc);
  return {
    headers: { from: get("from"), to: get("to"), cc: get("cc"), date: get("date"), subject: get("subject") },
    body: acc.plain || (acc.html ? stripHtml(acc.html) : ""),
    attachmentNames: acc.names,
  };
}

/**
 * Render a parsed embedded message as plain text for `doc_text`.
 *
 * @param eml result of {@link parseEml}
 * @returns header block, blank line, body, and a nested-attachments footer when present
 */
export function formatEml(eml: ParsedEml): string {
  const lines = (["from", "to", "cc", "date", "subject"] as const)
    .filter((k) => eml.headers[k])
    .map((k) => `${k[0].toUpperCase()}${k.slice(1)}: ${eml.headers[k]}`);
  const tail = eml.attachmentNames.length ? `\n\n[Attachments: ${eml.attachmentNames.join(", ")}]` : "";
  return `${lines.join("\n")}\n\n${eml.body}${tail}`.trim();
}
