/**
 * @file gmail/body-extract.ts
 * @description Pull a message body out of a Gmail `format=full` payload in the
 * shape the model asked for, and ALWAYS extract its links. Pure, no network.
 *
 * Body formats:
 *  - "text"  → decoded text/plain leaf (smallest / cheapest — the DEFAULT). Falls
 *              back to tags-stripped HTML when the message is HTML-only.
 *  - "html"  → decoded text/html leaf (falls back to the plain part wrapped as-is).
 *  - "rfc"   → the raw RFC822 body bytes decoded to a string (no MIME walking).
 *
 * `urls` is emitted regardless of the chosen format: anchor hrefs (label = link
 * text) from the HTML part plus bare URLs from the text part, deduped by href.
 */
import { parse } from "node-html-parser";

export type BodyFormat = "text" | "html" | "rfc";

export interface ExtractedUrl {
  /** Human-facing label: the anchor text, or the URL itself for bare links. */
  label: string;
  href: string;
}

export interface ExtractedBody {
  body: string;
  /** The format actually returned (may differ from the request on fallback). */
  bodyFormat: BodyFormat;
  urls: ExtractedUrl[];
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** First leaf of the given MIME type anywhere in the tree. */
function firstLeaf(payload: any, mimeType: string): string {
  if (!payload) return "";
  if (payload.mimeType === mimeType && payload.body?.data) return decodeBase64Url(payload.body.data);
  for (const p of payload.parts ?? []) {
    const t = firstLeaf(p, mimeType);
    if (t) return t;
  }
  return "";
}

/** Any decodable leaf (first one found) — last-ditch fallback. */
function anyLeaf(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data && !payload.parts) return decodeBase64Url(payload.body.data);
  for (const p of payload.parts ?? []) {
    const t = anyLeaf(p);
    if (t) return t;
  }
  return "";
}

/** Strip tags to readable text (entities decoded via node-html-parser). */
export function htmlToText(html: string): string {
  const root = parse(html, { comment: false });
  root.querySelectorAll("style,script").forEach((n) => n.remove());
  root.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
  for (const tag of ["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "blockquote"]) {
    root.querySelectorAll(tag).forEach((n) => n.insertAdjacentHTML("afterend", "\n"));
  }
  return root.textContent.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

// Bare-URL matcher for plain text (trailing punctuation trimmed below).
const BARE_URL = /https?:\/\/[^\s<>()"']+/gi;

/**
 * Extract links as `{ label, href }`, deduped by href (first label wins).
 * Anchors from the HTML part carry their visible text as the label; bare URLs
 * in the plain text use the URL as the label. Skips empty/`#`/`mailto:` anchors.
 */
export function extractUrls(html: string, text: string): ExtractedUrl[] {
  const seen = new Set<string>();
  const out: ExtractedUrl[] = [];
  const push = (href: string, label: string) => {
    const h = href.trim();
    if (!/^https?:\/\//i.test(h) || seen.has(h)) return;
    seen.add(h);
    out.push({ label: label.trim() || h, href: h });
  };
  if (html) {
    for (const a of parse(html, { comment: false }).querySelectorAll("a")) {
      const href = a.getAttribute("href");
      if (href) push(href, a.textContent);
    }
  }
  if (text) {
    for (const m of text.matchAll(BARE_URL)) {
      push(m[0].replace(/[.,;:!?)\]]+$/, ""), m[0].replace(/[.,;:!?)\]]+$/, ""));
    }
  }
  return out;
}

/**
 * Extract the body in the requested format plus the URL list.
 *
 * @param payload  the `payload` object from a Gmail `format=full` message
 * @param format   desired body format (default "text" — the most efficient)
 * @param rawRfc   optional raw RFC822 body (base64url `raw`); required for "rfc"
 */
export function extractBody(payload: any, format: BodyFormat = "text", rawRfc?: string): ExtractedBody {
  const plain = firstLeaf(payload, "text/plain");
  const html = firstLeaf(payload, "text/html");
  const urls = extractUrls(html, plain || (html ? htmlToText(html) : ""));

  if (format === "rfc") {
    if (rawRfc) return { body: decodeBase64Url(rawRfc), bodyFormat: "rfc", urls };
    // No raw available → fall back to the richest text we have.
    return { body: html || plain || anyLeaf(payload), bodyFormat: html ? "html" : "text", urls };
  }
  if (format === "html") {
    if (html) return { body: html, bodyFormat: "html", urls };
    return { body: plain || anyLeaf(payload), bodyFormat: "text", urls };
  }
  // "text" (default, most efficient)
  const body = plain || (html ? htmlToText(html) : anyLeaf(payload));
  return { body, bodyFormat: "text", urls };
}
