/**
 * @file mcp/text-sanitize.ts
 * @description Repair text slop on content sent INTO the write tools: mojibake
 * (UTF-8 bytes mis-decoded as Windows-1252, e.g. "â€"" for an em dash) and HTML
 * entity encoding ("&amp;" for "&"). Applied automatically by the tool runner to
 * content-bearing arg fields so drafts/docs/slides/etc. don't carry encoding
 * garbage. Pure, no network, testable.
 */

import { decodeHTML } from "entities";

/**
 * CP1252 code points for bytes 0x80–0x9F (the range that differs from
 * ISO-8859-1). Exactly 32 slots; the five undefined CP1252 bytes (0x81, 0x8D,
 * 0x8F, 0x90, 0x9D) keep their C1 control code point so the round-trip is
 * lossless and every index stays aligned. Index i maps to byte 0x80 + i.
 * Written as \u escapes: the literal glyphs (and the control chars) are too
 * copy-paste-fragile to trust — a single dropped slot shifts every mapping.
 */
const CP1252_HIGH =
  "\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F" +
  "\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178";

/**
 * Repair mojibake produced when UTF-8 bytes were decoded as Windows-1252.
 *
 * Reverses it by mapping each char back to its originating byte, then decoding
 * those bytes as UTF-8. Guarded: only runs when tell-tale sequences are present,
 * bails (returns the input untouched) if any char isn't CP1252-representable or
 * the byte stream isn't valid UTF-8 — so already-correct text is never mangled.
 *
 * Kept custom (not iconv-lite): a 32-char reverse map is zero-dependency and
 * avoids shipping full encoding tables into the Workers bundle, for identical
 * correctness — both approaches bail on non-representable / invalid input.
 *
 * ponytail: ceiling is a string that mixes real non-Latin text (emoji, CJK) with
 * mojibake — one non-mappable char bails the whole string. Upgrade path: segment
 * and repair per-run. Rare enough to skip until it bites.
 */
export function fixMojibake(s: string): string {
  if (!/Ã.|â€|Â[\s -¿]/.test(s)) return s;
  const bytes: number[] = [];
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (code <= 0xff) {
      bytes.push(code);
    } else {
      const i = CP1252_HIGH.indexOf(ch);
      if (i < 0) return s; // non-mappable char → not pure mojibake, leave alone
      bytes.push(0x80 + i);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return s; // not valid UTF-8 once reversed → wasn't mojibake
  }
}

/**
 * Decode HTML entities (named + numeric). Delegates to `entities` — the Node
 * gold standard, with ~2000 named refs and numeric edge cases a hand-rolled
 * table inevitably misses (&frac12;, &euro;, &sect;, accented names, …). Zero
 * runtime deps, pure-JS, Workers-safe. The leading `&` fast-path skips the
 * common no-entity string; non-entity `&` runs (R&D, AT&T, "Ben & Jerry") are
 * left untouched by the decoder.
 */
export function decodeEntities(s: string): string {
  return s.includes("&") ? decodeHTML(s) : s;
}

/** True if the string carries real HTML tags (so we must not touch its entities). */
function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(s);
}

/** Repair a single content string: always fix mojibake; decode entities only for non-HTML text. */
export function sanitizeContent(s: string): string {
  const fixed = fixMojibake(s);
  return looksLikeHtml(fixed) ? fixed : decodeEntities(fixed);
}

/**
 * Arg keys that carry human-authored content worth sanitizing. Identifier /
 * query / email fields are intentionally absent — decoding "&amp;" inside a
 * Drive query or an email address would corrupt it.
 *
 * ponytail: allowlist, not denylist — add keys as new content tools appear.
 */
const CONTENT_KEYS = new Set([
  "body", "text", "content", "subject", "title", "name", "markdown", "md",
  "description", "note", "notes", "message", "summary", "html", "value",
  "values", "caption", "label", "header", "footer",
  // NOTE: "code" is intentionally NOT a content key — code_mode_run's `code`
  // param is executable JS and must reach the sandbox byte-for-byte unmodified.
]);

/**
 * Recursively sanitize content-bearing string fields in a tool's arguments.
 * Once inside a content key, every nested string is sanitized (covers e.g.
 * Sheets `values` arrays). Returns a new object; the input is not mutated.
 */
export function sanitizeArgs<T>(args: T): T {
  const walk = (v: unknown, inContent: boolean): unknown => {
    if (typeof v === "string") return inContent ? sanitizeContent(v) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, inContent));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val, inContent || CONTENT_KEYS.has(k));
      }
      return out;
    }
    return v;
  };
  return walk(args, false) as T;
}
