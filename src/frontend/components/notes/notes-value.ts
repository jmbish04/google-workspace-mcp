/**
 * @fileoverview Serialization layer between the Tiptap editor document and the
 * team-notes API `body` column (a plain `string`).
 *
 * We do NOT change the backend schema. The `body` string stores a JSON-encoded
 * Tiptap document wrapped in a small versioned envelope so we can tell
 * rich-text bodies apart from legacy plain-text bodies that already exist in
 * the DB.
 *
 * Wire formats stored in `body`:
 *   {"v":2,"format":"tiptap","value":{ type:"doc", content:[ … ] }}   (new saves)
 *   {"v":1,"format":"plate","value":[ …slate nodes… ]}                 (read-only legacy)
 *
 * Legacy handling (the one-editor migration's compatibility contract, see
 * docs/decisions/2026-10-04-platejs-vs-tiptap.md): a stored v1 Plate envelope
 * is NEVER parsed into a Tiptap document as-is. It is read through a
 * PLAIN-TEXT FALLBACK — the Slate nodes are flattened to their text content
 * (see {@link plateValueToPlainText}) and lifted into plain paragraphs, so an
 * old note still loads and re-saves losslessly as a v2 Tiptap document once the
 * human edits it. The Plate mark/structure detail (bold, headings, list
 * nesting) is deliberately not translated — it degrades to text, never crashes.
 *
 * Anything that is NOT a parseable envelope of a known shape (legacy plain
 * text, or a note authored before this feature shipped) is treated as raw
 * plain text and lifted into single-line paragraphs so the editor / renderer
 * never crash.
 *
 * `tiptapDocToPlainText` produces the search/preview snippet — it walks the
 * Tiptap tree and concatenates text nodes. The team-notes API still only sees
 * a `string`, so previews and the server-side `q` search keep working against
 * the JSON blob; the snippet is purely a client-side convenience for list
 * cards.
 */

import type { TiptapDoc, TiptapNode } from "@/shared/tiptap-email";

/** Versioned envelopes that may live in the `body` column. */
interface TiptapEnvelope {
  v: 2;
  format: "tiptap";
  value: TiptapDoc;
}

/** The v1 Plate envelope shape (read-only — plain-text fallback only). */
interface PlateEnvelopeLike {
  v?: number;
  format?: string;
  value?: unknown;
}

const TIPTAP_VERSION = 2 as const;
const PLATE_VERSION = 1 as const;

/** A minimal, valid empty document (one empty paragraph). */
export function emptyTiptapDoc(): TiptapDoc {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

/** Wrap arbitrary plain text into a one-paragraph-per-line Tiptap document. */
export function plainTextToTiptapDoc(text: string): TiptapDoc {
  const raw = text ?? "";
  if (!raw.trim()) return emptyTiptapDoc();
  // Preserve hard line breaks as separate paragraphs so legacy multi-line
  // notes don't collapse into one run.
  const lines = raw.split(/\r?\n/);
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      content: [{ type: "text", text: line }],
    })),
  };
}

// ---------------------------------------------------------------------------
// Legacy Plate value → plain text (the read-only fallback)
// ---------------------------------------------------------------------------

/**
 * Flatten a stored Slate/Plate node tree to plain text. Shape is loose on
 * purpose — this is a *fallback reader* for historical data, so anything that
 * doesn't look like an element with `children` or a `{text}` leaf contributes
 * nothing rather than throwing.
 */
export function plateValueToPlainText(value: unknown): string {
  const parts: string[] = [];

  const isElement = (node: unknown): node is { children?: unknown[] } =>
    typeof node === "object" &&
    node !== null &&
    "children" in node &&
    Array.isArray((node as { children?: unknown[] }).children);

  const walk = (nodes: unknown[]): string => {
    let acc = "";
    for (const node of nodes) {
      if (isElement(node)) {
        acc += walk(node.children ?? []);
      } else if (
        typeof node === "object" &&
        node !== null &&
        typeof (node as { text?: unknown }).text === "string"
      ) {
        acc += (node as { text: string }).text;
      }
    }
    return acc;
  };

  if (!Array.isArray(value)) return "";
  for (const block of value) {
    if (isElement(block)) parts.push(walk(block.children ?? []));
    else if (
      typeof block === "object" &&
      block !== null &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.filter((p) => p.length > 0).join("\n");
}

/** Try to parse a v1 Plate envelope out of a stored string; null if not one. */
function tryParsePlateEnvelope(raw: string): string | null {
  if (!raw.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PlateEnvelopeLike>;
    if (
      parsed &&
      parsed.format === "plate" &&
      parsed.v === PLATE_VERSION &&
      Array.isArray(parsed.value)
    ) {
      return plateValueToPlainText(parsed.value);
    }
  } catch {
    /* not an envelope — fall through */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stored body string ⇄ Tiptap document
// ---------------------------------------------------------------------------

/**
 * Decode a stored `body` string into a Tiptap document for the editor/renderer.
 *
 * - Valid `{v:2,format:"tiptap",value:{…}}` envelope → returns `value`.
 * - Legacy `{v:1,format:"plate",value:[…]}` envelope → PLAIN-TEXT FALLBACK:
 *   the Slate nodes are flattened to text and lifted into paragraphs. Never
 *   crashes, never loses the words.
 * - Anything else (legacy plain text, malformed JSON, empty) → wraps the raw
 *   string as plain-text paragraphs. Never throws.
 */
export function bodyToTiptapDoc(body: string | null | undefined): TiptapDoc {
  const raw = body ?? "";
  if (!raw.trim()) return emptyTiptapDoc();

  // Only attempt JSON parsing if the string actually looks like our envelope;
  // this avoids accidentally interpreting a legacy note that happens to start
  // with `{` as malformed JSON and losing its text.
  if (raw.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<TiptapEnvelope> & Partial<PlateEnvelopeLike>;
      if (
        parsed &&
        parsed.format === "tiptap" &&
        parsed.v === TIPTAP_VERSION &&
        parsed.value &&
        parsed.value.type === "doc" &&
        Array.isArray(parsed.value.content)
      ) {
        return parsed.value as TiptapDoc;
      }
    } catch {
      // Fall through to plain-text handling below.
    }

    const plateText = tryParsePlateEnvelope(raw);
    if (plateText != null) return plainTextToTiptapDoc(plateText);
  }

  return plainTextToTiptapDoc(raw);
}

/**
 * Encode a Tiptap document into the `body` string for persistence. Empty
 * documents are stored as an empty string so the API's "body required"
 * validation behaves the same as before.
 */
export function tiptapDocToBody(doc: TiptapDoc | null | undefined): string {
  if (!doc || !Array.isArray(doc.content) || !tiptapDocToPlainText(doc).trim()) {
    return "";
  }
  const envelope: TiptapEnvelope = { v: TIPTAP_VERSION, format: "tiptap", value: doc };
  return JSON.stringify(envelope);
}

// ---------------------------------------------------------------------------
// Plain-text extraction (previews / snippets / empty checks)
// ---------------------------------------------------------------------------

/**
 * Flatten a Tiptap document to plain text for previews, search snippets, and
 * the NoteDialog "body required" check. Joins block-level nodes with newlines
 * and honours hard breaks.
 */
export function tiptapDocToPlainText(doc: TiptapDoc | TiptapNode | null | undefined): string {
  const walk = (node: TiptapNode): string => {
    if (node.type === "text" || node.text != null) return node.text ?? "";
    if (node.type === "hardBreak") return "\n";
    return (node.content ?? []).map(walk).join("");
  };

  if (!doc || !Array.isArray(doc.content)) return "";
  const parts = doc.content.map((block) => walk(block));
  return parts.filter((p) => p.length > 0).join("\n");
}

/** Convenience: derive the preview snippet directly from a stored body string. */
export function bodyToSnippet(body: string | null | undefined): string {
  return tiptapDocToPlainText(bodyToTiptapDoc(body));
}
