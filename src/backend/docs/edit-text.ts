/**
 * @file docs/edit-text.ts
 * @description Pure request builder for docs_edit_text: replace ONE located
 * match without touching its formatting. Only `insertText` and
 * `deleteContentRange` are emitted — never a style request.
 *
 * Style inheritance: Docs gives inserted text "the text style of the text
 * immediately before the insertion index". So the replacement is inserted
 * AFTER the first matched character (inside the match, inheriting its style),
 * then the rest of the original match and finally that first character are
 * deleted — later range first, so earlier indices never shift.
 *
 * The "first character" is 2 UTF-16 units when it's a surrogate pair (an
 * emoji etc.) — inserting inside the pair is invalid and Docs rejects it.
 */
import type { LocatedText, TextRun } from "@/backend/docs/locate";

export type EditTextPlan =
  | { ok: true; requests: Record<string, unknown>[] }
  | { ok: false; mixedStyles: true; runs: TextRun[] }
  | { ok: false; spansNonText: true; runs: TextRun[] };

/**
 * Plan a formatting-preserving replacement of one located match.
 *
 * @param hit - the match from {@link locateText}
 * @param replace - replacement text ("" deletes the match)
 * @param tabId - document tab the match lives in (omit for the first tab)
 * @returns the batchUpdate requests, `mixedStyles` when the match spans more than one text style, or `spansNonText` when the runs are not contiguous (a footnote reference, inline image, chip, or similar non-text element sits inside the match)
 * @throws If the match contains a paragraph break (deleting it would merge paragraphs)
 * @example
 * planTextEdit(locateText(doc, "ready for review")!, "approved and final")
 */
export function planTextEdit(hit: LocatedText, replace: string, tabId?: string): EditTextPlan {
  if (hit.runs.some((r) => r.content.includes("\n"))) {
    throw new Error("docs_edit_text cannot change paragraph breaks — edit within one paragraph");
  }
  if (!isContiguous(hit)) {
    return { ok: false, spansNonText: true, runs: hit.runs };
  }
  // ponytail: JSON.stringify equality relies on the API returning textStyle keys in a
  // stable order within one documents.get response; a key-sorted compare if that ever breaks.
  if (new Set(hit.runs.map((r) => JSON.stringify(r.textStyle))).size > 1) {
    return { ok: false, mixedStyles: true, runs: hit.runs };
  }

  const s = hit.startIndex;
  const e = hit.endIndex;
  const location = (index: number) => (tabId ? { index, tabId } : { index });
  const range = (startIndex: number, endIndex: number) => (tabId ? { startIndex, endIndex, tabId } : { startIndex, endIndex });

  if (!replace) return { ok: true, requests: [{ deleteContentRange: { range: range(s, e) } }] };

  // A surrogate-pair first character (e.g. an emoji) is 2 UTF-16 units; inserting
  // between its two units is invalid, so the insertion point moves past both.
  const first = hit.runs[0]?.content ?? "";
  const k = (first.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;

  const n = replace.length;
  const requests: Record<string, unknown>[] = [{ insertText: { location: location(s + k), text: replace } }];
  if (e - s > k) requests.push({ deleteContentRange: { range: range(s + k + n, e + n) } });
  requests.push({ deleteContentRange: { range: range(s, s + k) } });
  return { ok: true, requests };
}

/**
 * A match's runs are contiguous only when every run touches the next
 * (`runs[i].endIndex === runs[i+1].startIndex`) and the covered content
 * exactly fills `[startIndex, endIndex)`. A gap means a non-text element
 * (footnote reference, inline image, person/date chip, rich link, auto-text,
 * page break — anything that consumes an index but has no `textRun`) sits
 * inside the match; `locateText` silently skips those when building `full`,
 * so deleting the reconstructed range would also delete that element.
 *
 * @param hit - the match to check
 * @returns whether the match's runs cover its range with no gap
 */
function isContiguous(hit: LocatedText): boolean {
  for (let i = 0; i < hit.runs.length - 1; i++) {
    if (hit.runs[i].endIndex !== hit.runs[i + 1].startIndex) return false;
  }
  const covered = hit.runs.reduce((sum, r) => sum + r.content.length, 0);
  return hit.endIndex - hit.startIndex === covered;
}
