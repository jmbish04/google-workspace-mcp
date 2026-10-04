/**
 * @fileoverview Serialization layer for the task rich-text surface.
 *
 * Task DESCRIPTIONS and COMMENTS use a single rich-text editor whose content is
 * persisted to D1 as **sanitized HTML** (since Round 3). The content columns
 * stay plain `string`s — `tasks.description` and `task_comments.body` hold an
 * HTML fragment — so no schema change is needed.
 *
 * Since the Tiptap migration (see docs/decisions/2026-10-04-platejs-vs-tiptap.md)
 * this module no longer serializes editor values — the editor writes HTML via
 * `tiptapToHtml` (`shared/tiptap-email.ts`) and the browser editor parses HTML
 * itself. What remains are the readers that make the stored-string surface
 * robust, all framework-agnostic (no React, no DOM):
 *
 *  1. {@link normalizeStoredToHtml} — turn ANY stored string into displayable
 *     HTML, transparently upgrading the three legacy forms that may exist in the
 *     column: (a) an HTML fragment (Round 3+) → used as-is, (b) a Plate
 *     envelope `{v,format:"plate",value}` (Round 2) → PLAIN-TEXT FALLBACK: the
 *     Slate nodes are flattened to text and lifted into paragraphs (the words
 *     survive; the Plate structure does not), (c) plain text / lightweight
 *     markdown (Round 1 and earlier) → paragraph/`<br>` HTML. The result is
 *     NOT yet sanitized — callers sanitize at the render/persist boundary (see
 *     `sanitize-html.ts`).
 *
 *  2. {@link htmlToPlainText} — flatten any stored string to plain text for
 *     previews, search snippets, and "empty?" checks. Never returns markup.
 *
 *  3. {@link plateEnvelopeToPlainText} — the shared Plate-envelope reader used
 *     by BOTH the fallback above and the editor's seeding path. Returns null
 *     when the string is not an envelope, so callers can fall through.
 */

// ---------------------------------------------------------------------------
// Plate envelope reading (legacy, plain-text fallback only)
// ---------------------------------------------------------------------------

/** A Slate/Plate node as it may appear in a stored Round-2 envelope. */
type LoosePlateNode = {
  children?: unknown[];
  text?: unknown;
  [prop: string]: unknown;
};

/** Round-2 versioned envelope shape (only what we read). */
interface PlateEnvelope {
  v: 1;
  format: "plate";
  value: LoosePlateNode[];
}

/**
 * Flatten a stored Slate/Plate node tree to plain text. Shape is loose on
 * purpose — this is a *fallback reader* for historical data, so anything that
 * doesn't look like an element with `children` or a `{text}` leaf contributes
 * nothing rather than throwing. Blocks are joined with newlines.
 */
function plateValueToPlainText(value: unknown): string {
  const isElement = (node: unknown): node is LoosePlateNode =>
    typeof node === "object" && node !== null && "children" in node && Array.isArray(node.children);

  const walk = (nodes: unknown[]): string => {
    let acc = "";
    for (const node of nodes) {
      if (isElement(node)) {
        acc += walk(node.children ?? []);
      } else if (
        typeof node === "object" &&
        node !== null &&
        typeof (node as LoosePlateNode).text === "string"
      ) {
        acc += String((node as LoosePlateNode).text);
      }
    }
    return acc;
  };

  if (!Array.isArray(value)) return "";
  return value
    .map((block) => (isElement(block) ? walk(block.children ?? []) : ""))
    .filter((s: string) => s.length > 0)
    .join("\n");
}

/**
 * Try to read a Round-2 Plate envelope out of a stored string as PLAIN TEXT.
 * Returns null when the string is not such an envelope, so callers can fall
 * through to the HTML / plain-text handling. Never throws.
 */
export function plateEnvelopeToPlainText(stored: string | null | undefined): string | null {
  const raw = stored ?? "";
  if (!raw.trim() || !raw.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PlateEnvelope>;
    if (
      parsed &&
      parsed.format === "plate" &&
      parsed.v === 1 &&
      Array.isArray(parsed.value) &&
      parsed.value.length > 0
    ) {
      return plateValueToPlainText(parsed.value);
    }
  } catch {
    /* not an envelope — fall through */
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

/** Escape the five HTML-significant characters in text content. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Legacy / stored-string normalization
// ---------------------------------------------------------------------------

/** True when a stored string is (very likely) already an HTML fragment. */
function looksLikeHtml(raw: string): boolean {
  // A tag at the start, or any block/inline tag anywhere. Deliberately loose —
  // the render boundary sanitizes regardless, and plain text with stray `<`
  // falls through to the paragraph path below.
  return /<\/?(p|div|h[1-6]|ul|ol|li|blockquote|pre|code|strong|em|u|b|i|a|br)\b[^>]*>/i.test(raw);
}

/** Convert a plain-text / lightweight-markdown string into paragraph HTML. */
function plainTextToHtml(text: string): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  // Split on blank lines into paragraphs; single newlines become <br>.
  return trimmed
    .split(/\n{2,}/)
    .map((para) => {
      const inner = escapeHtml(para).replace(/\n/g, "<br>");
      return `<p>${inner}</p>`;
    })
    .join("");
}

/**
 * Normalize ANY stored content string into displayable (but not-yet-sanitized)
 * HTML, transparently upgrading the three legacy storage forms:
 *
 *  - Plate envelope (Round 2)   → plain-text fallback lifted into paragraphs.
 *  - HTML fragment (Round 3+)   → used verbatim.
 *  - plain text / markdown      → paragraph HTML.
 *
 * Callers MUST pass the result through the sanitizer before injecting it.
 */
export function normalizeStoredToHtml(stored: string | null | undefined): string {
  const raw = stored ?? "";
  if (!raw.trim()) return "";

  const plateText = plateEnvelopeToPlainText(raw);
  if (plateText != null) return plainTextToHtml(plateText);

  if (looksLikeHtml(raw)) return raw;

  return plainTextToHtml(raw);
}

// ---------------------------------------------------------------------------
// Plain-text extraction (previews / snippets / empty checks)
// ---------------------------------------------------------------------------

/** Strip tags + decode the common entities from an HTML fragment. */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Flatten any stored content string to plain text — safe for list previews,
 * search snippets, and "is this empty?" checks. Handles all three storage
 * forms and never returns markup.
 */
export function htmlToPlainText(stored: string | null | undefined): string {
  const raw = stored ?? "";
  if (!raw.trim()) return "";

  const plateText = plateEnvelopeToPlainText(raw);
  if (plateText != null) return plateText;

  if (looksLikeHtml(raw)) return stripHtmlTags(raw);

  return raw.trim();
}