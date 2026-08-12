/**
 * @file gmail/compose.ts
 * @description Build Gmail-ready message bodies. Gmail's HTML renderer ignores
 * `<style>` blocks and CSS classes — only INLINE `style=""` attributes survive —
 * so the worker inlines everything here (via `juice`) rather than trusting the
 * model to hand-write inline CSS. Markdown is rendered (marked) then inlined the
 * same way, so **bold**, headings, lists, links, etc. arrive formatted.
 *
 * Pipeline: SANITIZE (node-html-parser strips <script>/<link>/<iframe>/… tags,
 * on* handlers, and javascript: URLs — juice does NOT sanitize) → INLINE (juice
 * flattens the default Gmail stylesheet + the html's own <style> blocks into
 * inline `style=""`, handling CSS specificity/shorthand correctly, then removes
 * the <style> tags).
 *
 * Workers-safe: `juice.inlineContent` (no filesystem/remote fetch), marked, and
 * node-html-parser — no Node built-ins at runtime (nodejs_compat covers the rest).
 */
import juice from "juice";
import { marked } from "marked";
import { parse } from "node-html-parser";

/**
 * Gmail-safe default style per tag. Inlined as a stylesheet (author inline styles
 * and more-specific rules win via CSS specificity). Inline properties relied on
 * (the Gmail-safe subset): color, background-color, font-family, font-size,
 * font-weight, font-style, text-decoration, text-align, margin, padding, border,
 * border-*, line-height. Web-safe font stacks only (Outlook substitutes freely).
 */
const TAG_STYLES: Record<string, string> = {
  h1: "font-size:24px;font-weight:700;margin:16px 0 8px;line-height:1.3;",
  h2: "font-size:20px;font-weight:700;margin:16px 0 8px;line-height:1.3;",
  h3: "font-size:17px;font-weight:700;margin:14px 0 6px;line-height:1.3;",
  h4: "font-size:15px;font-weight:700;margin:12px 0 6px;",
  h5: "font-size:13px;font-weight:700;margin:12px 0 6px;",
  h6: "font-size:12px;font-weight:700;margin:12px 0 6px;color:#5f6368;",
  p: "margin:0 0 12px;line-height:1.5;",
  a: "color:#1a73e8;text-decoration:underline;",
  strong: "font-weight:700;",
  b: "font-weight:700;",
  em: "font-style:italic;",
  i: "font-style:italic;",
  ul: "margin:0 0 12px;padding-left:24px;",
  ol: "margin:0 0 12px;padding-left:24px;",
  li: "margin:4px 0;line-height:1.5;",
  blockquote: "margin:0 0 12px;padding:8px 12px;border-left:3px solid #dadce0;color:#5f6368;",
  code: "font-family:ui-monospace,Menlo,Consolas,monospace;background:#f1f3f4;padding:2px 4px;border-radius:3px;font-size:90%;",
  pre: "font-family:ui-monospace,Menlo,Consolas,monospace;background:#f1f3f4;padding:12px;border-radius:6px;overflow:auto;margin:0 0 12px;",
  hr: "border:none;border-top:1px solid #dadce0;margin:16px 0;",
  table: "border-collapse:collapse;margin:0 0 12px;",
  th: "border:1px solid #dadce0;padding:6px 10px;text-align:left;background:#f8f9fa;",
  td: "border:1px solid #dadce0;padding:6px 10px;",
  img: "max-width:100%;height:auto;",
};

/** The default stylesheet as CSS, fed to juice as the base rules. */
const DEFAULT_GMAIL_CSS = Object.entries(TAG_STYLES)
  .map(([tag, style]) => `${tag}{${style}}`)
  .join("\n");

/**
 * Elements that must never survive into a Gmail-bound HTML part: active content
 * (`script`), remote/embedded CSS or documents (`link`, `iframe`, `object`,
 * `embed`, `base`), and document chrome (`meta`, `head`, `title`). `<style>` is
 * intentionally kept here so juice can inline it, then juice removes it.
 */
const DANGEROUS_TAGS = ["script", "link", "iframe", "object", "embed", "base", "meta", "head", "title", "noscript"];

/**
 * Strip dangerous tags, `on*` event-handler attributes, and `javascript:`/
 * `vbscript:` URLs — the sanitization juice does not do. Keeps `<style>` for
 * juice to inline.
 */
function sanitizeHtml(html: string): string {
  const root = parse(html, { comment: false });
  for (const tag of DANGEROUS_TAGS) root.querySelectorAll(tag).forEach((n) => n.remove());
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

/**
 * Sanitize + flatten all styling to inline `style=""` for Gmail. Uses juice for
 * the CSS inlining (correct specificity + shorthand handling) after the safety
 * pass. Media queries are preserved (Gmail honors `<style>`-in-head media queries
 * for responsive tweaks) while all static rules are inlined for the base render.
 */
export function inlineGmailStyles(html: string): string {
  const sanitized = sanitizeHtml(html);
  // Inject the default stylesheet as a <style> block, then let juice inline BOTH
  // it and the html's own <style> blocks (juice.inlineContent only inlines the
  // css arg, not the document's <style> tags), and strip all <style> after.
  const withDefaults = `<style>${DEFAULT_GMAIL_CSS}</style>${sanitized}`;
  return juice(withDefaults, {
    removeStyleTags: true,
    preserveMediaQueries: true,
    preserveImportant: true,
  });
}

/** Render markdown to Gmail-inlined HTML. */
export function markdownToGmailHtml(md: string): string {
  const html = marked.parse(md, { async: false, gfm: true, breaks: true }) as string;
  return inlineGmailStyles(html);
}

/** Best-effort plain-text fallback from HTML (block tags → newlines). */
export function htmlToPlainText(html: string): string {
  const root = parse(html, { comment: false });
  root.querySelectorAll("style,script").forEach((n) => n.remove());
  root.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
  for (const tag of ["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "blockquote"]) {
    root.querySelectorAll(tag).forEach((n) => n.insertAdjacentHTML("afterend", "\n"));
  }
  return root.textContent.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * Resolve caller-supplied body into `{ html, text }`. Priority: markdown → html →
 * plain text. `html`/`markdown` yield an inlined HTML part plus a plain-text
 * alternative; plain `text` stays text-only (no HTML part).
 */
export function composeBody(input: { text?: string; html?: string; markdown?: string }): {
  html?: string;
  text: string;
} {
  if (input.markdown != null && input.markdown !== "") {
    return { html: markdownToGmailHtml(input.markdown), text: input.markdown };
  }
  if (input.html != null && input.html !== "") {
    const html = inlineGmailStyles(input.html);
    return { html, text: htmlToPlainText(html) };
  }
  return { text: input.text ?? "" };
}
