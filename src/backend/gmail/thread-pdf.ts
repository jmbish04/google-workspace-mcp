/**
 * @file gmail/thread-pdf.ts
 * @description Build a print-ready, Gmail-styled HTML document for one or more
 * messages so it can be rendered to PDF (via Browser Rendering). Pure: turns raw
 * Gmail `format=full` payloads into `{ from, to, date, subject, bodyHtml }` rows
 * and lays them out as a thread. Header fields are HTML-escaped; message bodies
 * are lightly sanitized (script/iframe/style stripped) but otherwise preserved.
 */
import { parse } from "node-html-parser";

import { extractBody } from "./body-extract";

export interface RenderMessage {
  from: string;
  to: string;
  date: string;
  subject: string;
  bodyHtml: string;
}

/** A term to highlight in message bodies + the background color to use. */
export interface Highlight {
  term: string;
  /** Hex color, with or without leading `#` (e.g. "#ffe600" or "purple"→invalid, use hex). */
  color: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeColor(c: string): string {
  return c.startsWith("#") ? c : `#${c}`;
}

/**
 * Wrap occurrences of each highlight `term` in `<mark>` with its color. Operates
 * only on TEXT between tags (splits on `<...>`) so it never corrupts attributes
 * or tag names, and uses ONE combined regex so freshly-inserted `<mark>` markup
 * isn't re-matched. Case-insensitive; longer terms win when they overlap.
 */
export function applyHighlights(html: string, highlights: Highlight[]): string {
  const valid = highlights
    .filter((h) => h.term && /^#?[0-9a-fA-F]{3,8}$/.test(h.color))
    .sort((a, b) => b.term.length - a.term.length);
  if (!valid.length) return html;

  const colorFor = new Map(valid.map((h) => [h.term.toLowerCase(), normalizeColor(h.color)]));
  const re = new RegExp(`(${valid.map((h) => escapeRegex(h.term)).join("|")})`, "gi");
  const fallback = normalizeColor(valid[0].color);

  // Even indices are text between tags; odd indices are the tags themselves.
  return html
    .split(/(<[^>]+>)/)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(re, (m) => `<mark style="background-color:${colorFor.get(m.toLowerCase()) ?? fallback};padding:0 1px">${m}</mark>`),
    )
    .join("");
}

function escapeHtml(str: string): string {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function headerValue(headers: any[], name: string): string {
  return headers?.find((h) => h?.name?.toLowerCase() === name)?.value ?? "";
}

/**
 * Strip active-content tags + handlers from a message body before it's rendered
 * to PDF by Browser Rendering. Removes script/iframe/object/embed/link/meta/style,
 * `on*` handlers, and `javascript:`/`vbscript:` URLs.
 *
 * ponytail: remote `<img src="https://…">` and CSS `url(…)` are left intact so the
 * PDF matches the real email (inline logos etc). The headless render therefore
 * fetches those URLs — same effect as opening the email (tracking pixels fire,
 * outbound GETs originate from the render env). Acceptable: the user is rendering
 * their OWN mail. Upgrade path if that matters: block remote fetches via a CSP on
 * the rendered doc, or rewrite remote src to data: after fetching server-side.
 */
function sanitizeBody(html: string): string {
  const root = parse(html, { comment: false });
  root.querySelectorAll("script,iframe,object,embed,link,meta,style").forEach((n) => n.remove());
  for (const el of root.querySelectorAll("*")) {
    for (const attr of Object.keys(el.attributes)) {
      if (/^on/i.test(attr)) el.removeAttribute(attr);
    }
    for (const urlAttr of ["href", "src", "xlink:href", "action", "formaction", "background"]) {
      const v = el.getAttribute(urlAttr);
      if (v && /^\s*(javascript|vbscript):/i.test(v)) el.removeAttribute(urlAttr);
    }
  }
  return root.toString();
}

/** Convert a raw Gmail `format=full` message into a render row. */
export function toRenderMessage(raw: any): RenderMessage {
  const payload = raw?.payload ?? {};
  const headers: any[] = payload.headers ?? [];
  const { body, bodyFormat } = extractBody(payload, "html");
  // A text-only message: preserve line breaks in the PDF.
  const bodyHtml =
    bodyFormat === "html" ? sanitizeBody(body) : `<div style="white-space:pre-wrap">${escapeHtml(body)}</div>`;
  return {
    from: headerValue(headers, "from"),
    to: headerValue(headers, "to"),
    date: headerValue(headers, "date"),
    subject: headerValue(headers, "subject"),
    bodyHtml,
  };
}

/** Assemble the full Gmail-styled print HTML for a set of messages. */
export function buildThreadHtml(threadSubject: string, messages: RenderMessage[], highlights: Highlight[] = []): string {
  const messagesHtml = messages
    .map(
      (m) => `
      <div class="email-message">
        <table class="meta-table"><tbody>
          <tr>
            <td><span class="sender-name">${escapeHtml(m.from)}</span></td>
            <td class="timestamp">${escapeHtml(m.date)}</td>
          </tr>
          <tr><td colspan="2" class="recipient-line">To: ${escapeHtml(m.to)}</td></tr>
        </tbody></table>
        <div class="email-body">${applyHighlights(m.bodyHtml, highlights)}</div>
      </div>`,
    )
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #222; margin: 10px; line-height: 1.4; background: #fff; }
    .thread-title { font-size: 20px; color: #202124; margin: 0 0 20px 0; font-weight: 400; }
    .email-message { border-top: 1px solid #dadce0; padding-top: 16px; margin-bottom: 28px; }
    .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
    .sender-name { font-weight: 700; color: #202124; }
    .timestamp { text-align: right; font-size: 12px; color: #5f6368; white-space: nowrap; }
    .recipient-line { font-size: 12px; color: #5f6368; padding-top: 2px; }
    .email-body { margin-top: 16px; color: #222; word-wrap: break-word; }
    .email-body img { max-width: 100%; height: auto; }
    @media print { body { margin: 0; font-size: 11pt; } .email-message { page-break-inside: avoid; } }
  </style></head><body>
  <h1 class="thread-title">${escapeHtml(threadSubject)}</h1>
  ${messagesHtml}
  </body></html>`.trim();
}
