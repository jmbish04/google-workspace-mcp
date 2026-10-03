/**
 * @file gmail/compose.ts
 * @description The ONE place every outgoing email body is turned into a
 * Gmail-ready HTML part. HTML is the standard — a text-only body is crap mail
 * (no bullets, no numbered lists, no links, no bold, no paragraph spacing), so
 * `composeBody` always produces an HTML part and derives the text/plain
 * alternative from it.
 *
 * The house formatting rules are the Gmail HTML standard recorded in the
 * colby-maestro plan "Gmail HTML standard + draft studio": Arial/Helvetica
 * 14px/1.5 #222222, paragraphs as `<p>` with a 16px bottom margin (never faked
 * with empty paragraphs or stacked `<br>`), `#1155cc` underlined links, 24px
 * list indent with 6px between items, and a plain left-aligned
 * `max-width:650px` container — NOT a centered boxed card on a grey field.
 * This is personal mail, not a newsletter.
 *
 * On `<style>`: Gmail does support class/element/ID selectors and media queries
 * in a `<style>` block (developers.google.com/workspace/gmail/design/css). We
 * inline everything static anyway, because a `<style>` block is unreliable the
 * moment the message is quoted in a reply, forwarded, or read in another
 * client. Media queries are the exception — they cannot be inlined, so juice
 * leaves those in place.
 *
 * Pipeline (`composeBody`):
 *   1. SOURCE   markdown → rendered · html → as-is · text → escaped paragraphs
 *   2. SANITIZE strip <script>/<iframe>/<form>/…, on* handlers, javascript: urls
 *   3. DESTAMP  remove hidden `ref:<uuid>` markers and authorship tags belonging
 *               to OTHER messages — an agent that edits a previous draft carries
 *               them along, and three revisions means three reference ids
 *   4. BLOCKS   reshape into `<p>` paragraphs (toEmailBlocks)
 *   5. INLINE   flatten the Gmail default stylesheet + the html's own <style>
 *               blocks into inline `style=""` (juice: correct CSS specificity
 *               and shorthand handling) — the "Mailchimp inliner" step
 *   6. WRAP     the <div dir="ltr"> 650px Arial wrapper, and stamp the ref
 *   7. VALIDATE reject a body that sanitizes down to nothing
 *
 * Workers-safe: juice.inlineContent (no filesystem/remote fetch), marked, and
 * node-html-parser — no Node built-ins at runtime.
 */
import juice from "juice";
import { marked } from "marked";
import { parse, type HTMLElement, type Node } from "node-html-parser";

/** The typography every block repeats, because Gmail does not reliably inherit it. */
const TYPOGRAPHY = "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;";

/**
 * The body wrapper. `max-width:650px` keeps a line readable on a 32-inch
 * monitor, `width:100%` lets it scale down on a phone, and the transparent
 * background keeps it looking like mail rather than a marketing card.
 */
export const GMAIL_BODY_STYLE = `max-width:650px;width:100%;text-align:left;background-color:transparent;${TYPOGRAPHY}`;

/** @deprecated Use `GMAIL_BODY_STYLE`. Kept so older callers still compile. */
export const GMAIL_NATIVE_STYLE = GMAIL_BODY_STYLE;

/** Style used for machine-readable markers that must be invisible to a reader. */
export const HIDDEN_STYLE = "color:#ffffff;font-size:1px;line-height:1px;mso-hide:all";

/** The per-paragraph authorship watermark (see gmail/authored-html.ts). */
export const AUTHORED_TAG_RE = /\[authored v1 ([0-9a-f-]{36}) (\d{1,4}) ([0-9a-f]{12})\]/;

/** First words of the hidden authorship legend, used to recognise and strip it. */
export const LEGEND_MARK = "Authorship watermark v1";

/** A hidden reference marker's text: `ref:<uuid>`. */
const REF_TEXT_RE = /^ref:([0-9a-f-]{36})$/i;

/**
 * The element styling spec, inlined as a stylesheet so juice resolves CSS
 * specificity and shorthand correctly (an author's own inline style still
 * wins). Only properties on Gmail's supported list are used.
 *
 * Note what is NOT here: `<p>` carries its own typography rather than
 * inheriting it, because Gmail drops the wrapper's font on quoted replies.
 */
const TAG_STYLES: Record<string, string> = {
  p: `margin:0 0 16px 0;${TYPOGRAPHY}`,
  h1: `font-size:24px;font-weight:700;margin:0 0 12px;line-height:1.3;font-family:Arial,Helvetica,sans-serif;color:#222222;`,
  h2: `font-size:20px;font-weight:700;margin:0 0 12px;line-height:1.3;font-family:Arial,Helvetica,sans-serif;color:#222222;`,
  h3: `font-size:16px;font-weight:700;margin:0 0 10px;line-height:1.3;font-family:Arial,Helvetica,sans-serif;color:#222222;`,
  h4: `font-size:14px;font-weight:700;margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;color:#222222;`,
  h5: `font-size:14px;font-weight:700;margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;color:#222222;`,
  h6: `font-size:13px;font-weight:700;margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;color:#5f6368;`,
  a: "color:#1155cc;text-decoration:underline;",
  strong: "font-weight:700;color:#222222;",
  b: "font-weight:700;color:#222222;",
  em: "font-style:italic;",
  i: "font-style:italic;",
  ul: `margin:0 0 16px 0;padding-left:24px;list-style-type:disc;list-style-position:outside;${TYPOGRAPHY}`,
  ol: `margin:0 0 16px 0;padding-left:24px;list-style-type:decimal;list-style-position:outside;${TYPOGRAPHY}`,
  li: "margin-bottom:6px;",
  blockquote:
    "margin:12px 0 16px 16px;padding-left:12px;border-left:2px solid #dadce0;color:#5f6368;font-style:italic;",
  code: "font-family:ui-monospace,Menlo,Consolas,monospace;background:#f1f3f4;padding:2px 4px;border-radius:3px;font-size:90%;",
  pre: "font-family:ui-monospace,Menlo,Consolas,monospace;background:#f1f3f4;padding:12px;border-radius:6px;overflow:auto;margin:0 0 16px;",
  hr: "border:none;border-top:1px solid #dadce0;margin:16px 0;",
  table: `border-collapse:collapse;margin:0 0 16px;${TYPOGRAPHY}`,
  th: "border:1px solid #dadce0;padding:6px 10px;text-align:left;background:#f8f9fa;",
  td: "border:1px solid #dadce0;padding:6px 10px;",
  img: "max-width:100%;height:auto;",
};

/**
 * Class hooks an author can use by name. juice inlines these the same way, so
 * `<span class="highlight-red">` arrives styled even though Gmail's handling of
 * `<style>` is unreliable in quoted copies.
 */
const CLASS_STYLES: Record<string, string> = {
  "highlight-red": "color:#c5221f;font-weight:600;",
  signature: `margin-top:24px;${TYPOGRAPHY}`,
};

/** The spec as CSS, fed to juice as the base rules. */
const DEFAULT_GMAIL_CSS = [
  ...Object.entries(TAG_STYLES).map(([tag, style]) => `${tag}{${style}}`),
  ...Object.entries(CLASS_STYLES).map(([cls, style]) => `.${cls}{${style}}`),
].join("\n");

/**
 * Elements that must never survive into a Gmail-bound HTML part: active content
 * (`script`), remote/embedded CSS or documents (`link`, `iframe`, `object`,
 * `embed`, `base`), document chrome (`meta`, `head`, `title`), and the
 * interactive/media elements Gmail strips anyway (`form`, `input`, `button`,
 * `svg`, `video`, …) — stripping them here means the sender sees the same body
 * the recipient will. `<style>` is intentionally kept so juice can inline it;
 * juice removes it afterwards.
 */
const DANGEROUS_TAGS = [
  "script", "link", "iframe", "object", "embed", "base", "meta", "head", "title", "noscript",
  "form", "input", "select", "textarea", "button", "svg", "video", "audio", "canvas", "map", "applet",
];

/** Block-level tags recognised when reshaping into Gmail's native structure. */
const BLOCK_TAGS = new Set(["div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "table", "ul", "ol", "hr"]);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isElement(n: Node): n is HTMLElement {
  return n.nodeType === 1;
}

/* --------------------------------------------------------------- repair --- */

/**
 * Strip dangerous tags, `on*` event-handler attributes, and `javascript:`/
 * `vbscript:` URLs — the sanitization juice does not do. Keeps `<style>` for
 * juice to inline. Mutates `root`; returns the tag names it removed.
 */
function sanitizeInto(root: HTMLElement): string[] {
  const removed: string[] = [];
  for (const tag of DANGEROUS_TAGS) {
    for (const n of root.querySelectorAll(tag)) {
      removed.push(tag);
      n.remove();
    }
  }
  for (const el of root.querySelectorAll("*")) {
    for (const attr of Object.keys(el.attributes)) {
      if (/^on/i.test(attr)) el.removeAttribute(attr);
    }
    for (const urlAttr of ["href", "src", "xlink:href", "action", "formaction", "background"]) {
      const v = el.getAttribute(urlAttr);
      if (v && /^\s*(javascript|vbscript):/i.test(v)) el.removeAttribute(urlAttr);
    }
  }
  return removed;
}

/**
 * Remove hidden `ref:<uuid>` markers and authorship watermark tags that belong
 * to a DIFFERENT message, keeping only `keepUuid`'s own.
 *
 * Why this is not optional: an agent asked to "revise that draft" feeds the
 * previous draft's body back in. Without this, revision two carries two
 * reference ids and revision three carries three, and every stale authorship
 * tag claims text the signature no longer covers. Mutates `root`.
 */
export function stripForeignStamps(root: HTMLElement, keepUuid?: string): { refs: string[]; tags: number } {
  const refs: string[] = [];
  let tags = 0;

  for (const el of root.querySelectorAll("*")) {
    if (el.childNodes.some(isElement)) continue; // only leaf markers
    const m = REF_TEXT_RE.exec(el.textContent.trim());
    if (!m) continue;
    if (keepUuid && m[1].toLowerCase() === keepUuid.toLowerCase()) continue;
    refs.push(m[1]);
    el.remove();
  }

  let ownTagsLeft = 0;
  for (const span of root.querySelectorAll("span")) {
    const m = AUTHORED_TAG_RE.exec(span.textContent);
    if (!m) continue;
    if (keepUuid && m[1].toLowerCase() === keepUuid.toLowerCase()) {
      ownTagsLeft++;
      continue;
    }
    tags++;
    span.remove();
  }
  // The legend only means something while signed blocks remain.
  if (ownTagsLeft === 0) {
    for (const el of root.querySelectorAll("div")) {
      if (el.textContent.trimStart().startsWith(LEGEND_MARK)) el.remove();
    }
  }
  // A text-only body may carry the marker as a bare trailing line.
  if (!keepUuid || refs.length) {
    for (const t of root.childNodes) {
      if (isElement(t)) continue;
      const cleaned = t.textContent.replace(/^\s*ref:[0-9a-f-]{36}\s*$/gim, "");
      if (cleaned !== t.textContent) t.textContent = cleaned;
    }
  }
  return { refs, tags };
}

/* ------------------------------------------------------------ structure --- */

/**
 * Reshape arbitrary html into the house block structure: every paragraph is a
 * `<p>`, which the stylesheet gives a 16px bottom margin.
 *
 * This is what fixes the "AI wrote one wall of text" problem. Note what it does
 * NOT do: it never emits an empty paragraph or a stacked `<br>` to make a gap,
 * and it DROPS the blank spacer divs that arrive in a body copied out of Gmail
 * — faked spacing collapses differently in every client, so the gap has to be
 * the margin.
 */
export function toEmailBlocks(html: string): string {
  const root = parse(html, { comment: false });
  const blocks: string[] = [];
  let inline = "";
  const flush = () => {
    if (inline.replace(/<br\s*\/?>/gi, "").trim()) blocks.push(`<p>${inline.trim()}</p>`);
    inline = "";
  };
  for (const node of root.childNodes) {
    const tag = isElement(node) ? node.tagName.toLowerCase() : "";
    if (!BLOCK_TAGS.has(tag)) {
      inline += node.toString();
      continue;
    }
    flush();
    const el = node as HTMLElement;
    // A bare <div> paragraph (what Gmail's own compose emits) becomes a <p>;
    // an empty one was only ever a spacer, and the margin replaces it.
    if (tag === "div" || tag === "p") {
      if (!el.text.trim() && !el.querySelector("img")) continue;
      blocks.push(`<p${attrsOf(el)}>${el.innerHTML}</p>`);
    } else {
      blocks.push(el.toString());
    }
  }
  flush();
  return blocks.join("");
}

/** Re-emit the attributes worth keeping when a block is retagged as `<p>`. */
function attrsOf(el: HTMLElement): string {
  const keep = ["class", "dir", "data-plaintext", "id"];
  return keep
    .map((a) => (el.getAttribute(a) ? ` ${a}="${escapeHtml(el.getAttribute(a)!)}"` : ""))
    .join("");
}

/** Plain text → escaped paragraphs (blank line = new paragraph, newline = `<br>`). */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${para.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}

/* -------------------------------------------------------------- inline --- */

/**
 * Sanitize + flatten all styling to inline `style=""` for Gmail. juice handles
 * the CSS inlining (correct specificity + shorthand) after the safety pass.
 * Media queries survive (Gmail honours `<style>`-in-head media queries) while
 * every static rule is inlined for the base render.
 */
export function inlineGmailStyles(html: string): string {
  const root = parse(html, { comment: false });
  sanitizeInto(root);
  const withDefaults = `<style>${DEFAULT_GMAIL_CSS}</style>${root.toString()}`;
  return juice(withDefaults, { removeStyleTags: true, preserveMediaQueries: true, preserveImportant: true });
}

/** Render markdown to Gmail-inlined HTML. */
export function markdownToGmailHtml(md: string): string {
  const html = marked.parse(md, { async: false, gfm: true, breaks: true }) as string;
  return inlineGmailStyles(html);
}

/* --------------------------------------------------------------- stamp --- */

/** Hidden (white, collapsed, omitted from text/plain) marker carrying the reference id. */
export function refMarkerHtml(uuid: string): string {
  return `<div data-plaintext="omit" style="${HIDDEN_STYLE};max-height:0;overflow:hidden">ref:${uuid}</div>`;
}

/** Wrap inner HTML in the house body container. */
export function wrapGmailNative(inner: string): string {
  return `<div dir="ltr" style="${GMAIL_BODY_STYLE}">${inner}</div>`;
}

/**
 * Insert a fragment at the top of the body, INSIDE the native wrapper so it
 * inherits the message font instead of rendering in the client default.
 */
export function prependInsideBody(html: string, fragment: string): string {
  const open = /^(\s*<div\b[^>]*\bdir="ltr"[^>]*>)/i.exec(html);
  return open ? html.replace(open[1], `${open[1]}${fragment}`) : fragment + html;
}

/* --------------------------------------------------------------- plain --- */

/**
 * Best-effort plain-text fallback from HTML (block tags → newlines). Elements
 * marked `data-plaintext="omit"` (the hidden reference marker and the authorship
 * watermark) are dropped — invisible in the HTML part, invisible here too.
 */
export function htmlToPlainText(html: string): string {
  const root = parse(html, { comment: false });
  root.querySelectorAll("style,script").forEach((n) => n.remove());
  root.querySelectorAll('[data-plaintext="omit"]').forEach((n) => n.remove());
  root.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
  // A paragraph break is a BLANK line in text/plain. Without this the
  // text alternative runs every paragraph together, which is the same defect
  // the HTML part exists to fix.
  for (const tag of ["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"]) {
    root.querySelectorAll(tag).forEach((n) => n.insertAdjacentHTML("afterend", "\n\n"));
  }
  for (const tag of ["li", "tr"]) {
    root.querySelectorAll(tag).forEach((n) => n.insertAdjacentHTML("afterend", "\n"));
  }
  return root.textContent.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

/* ------------------------------------------------------------ composeBody - */

/** Thrown when the supplied body cannot be repaired into a sendable HTML part. */
export class GmailBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailBodyError";
  }
}

/** What the worker changed on the way through, so the caller can see and learn. */
export interface ComposeReport {
  /** Which input was used (markdown → html → text, in that order). */
  source: "markdown" | "html" | "text";
  /** Reference ids belonging to OTHER messages that were removed. */
  removedRefs: string[];
  /** Authorship watermark tags from other messages that were removed. */
  removedAuthorTags: number;
  /** Tag names stripped as unsafe or unsupported in Gmail. */
  removedUnsafe: string[];
  /** Things the sender should know (never fatal). */
  warnings: string[];
}

export interface ComposedBody {
  html: string;
  text: string;
  report: ComposeReport;
}

export interface ComposeOptions {
  /**
   * This message's reference id. Stamped as a hidden white marker if absent,
   * and the ONLY id kept — every other message's markers are stripped.
   */
  uuid?: string;
  /**
   * The html was already built by `buildAuthoredBody` (native-wrapped, stamped,
   * watermarked). Skip normalisation so the signed text ships byte-identical to
   * what was signed; only derive the text alternative.
   */
  prebuilt?: boolean;
}

/**
 * Turn caller intent into the Gmail-native `{ html, text }` pair. HTML is always
 * produced — priority markdown → html → text.
 *
 * @throws {GmailBodyError} when the body has no visible content after repair.
 */
export function composeBody(
  input: { text?: string; html?: string; markdown?: string },
  opts: ComposeOptions = {},
): ComposedBody {
  const source: ComposeReport["source"] =
    input.markdown ? "markdown" : input.html ? "html" : "text";
  const report: ComposeReport = { source, removedRefs: [], removedAuthorTags: 0, removedUnsafe: [], warnings: [] };

  if (opts.prebuilt && input.html) {
    return { html: input.html, text: htmlToPlainText(input.html), report };
  }

  const raw =
    source === "markdown"
      ? (marked.parse(input.markdown!, { async: false, gfm: true, breaks: true }) as string)
      : source === "html"
        ? input.html!
        : textToHtml(input.text ?? "");

  // An already-wrapped body (a previous draft fed back in) is unwrapped first,
  // so re-composing never nests one Gmail wrapper inside another.
  const parsed = parse(raw, { comment: false });
  const kids = parsed.childNodes.filter((n) => isElement(n) || n.textContent.trim());
  const only = kids.length === 1 && isElement(kids[0]) ? (kids[0] as HTMLElement) : undefined;
  const root =
    only && only.tagName?.toLowerCase() === "div" && only.getAttribute("dir") === "ltr"
      ? parse(only.innerHTML, { comment: false })
      : parsed;

  report.removedUnsafe = [...new Set(sanitizeInto(root))];
  const stripped = stripForeignStamps(root, opts.uuid);
  report.removedRefs = stripped.refs;
  report.removedAuthorTags = stripped.tags;

  let inner = inlineGmailStyles(toEmailBlocks(root.toString()));
  if (opts.uuid && !inner.includes(`ref:${opts.uuid}`)) inner += refMarkerHtml(opts.uuid);
  const html = wrapGmailNative(inner);

  const text = htmlToPlainText(html);
  if (!text && !/<img\b/i.test(html)) {
    throw new GmailBodyError(
      `Email body has no visible content after sanitizing${
        report.removedUnsafe.length ? ` (removed: ${report.removedUnsafe.join(", ")})` : ""
      }. Send text, markdown, or HTML whose visible content survives Gmail's renderer.`,
    );
  }

  if (report.removedUnsafe.length) {
    report.warnings.push(
      `Removed ${report.removedUnsafe.join(", ")} — Gmail strips these; the recipient would not have seen them.`,
    );
  }
  if (report.removedRefs.length) {
    report.warnings.push(
      `Removed ${report.removedRefs.length} reference id(s) carried over from an earlier draft (${report.removedRefs.join(", ")}). Each message keeps exactly one.`,
    );
  }
  if (report.removedAuthorTags) {
    report.warnings.push(`Removed ${report.removedAuthorTags} authorship watermark tag(s) from an earlier message.`);
  }
  return { html, text, report };
}
