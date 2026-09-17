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
 */
import type { LocatedText, TextRun } from "@/backend/docs/locate";

export type EditTextPlan =
  | { ok: true; requests: Record<string, unknown>[] }
  | { ok: false; mixedStyles: true; runs: TextRun[] };

/**
 * Plan a formatting-preserving replacement of one located match.
 *
 * @param hit - the match from {@link locateText}
 * @param replace - replacement text ("" deletes the match)
 * @param tabId - document tab the match lives in (omit for the first tab)
 * @returns the batchUpdate requests, or `mixedStyles` with the runs when the match spans more than one text style
 * @throws If the match contains a paragraph break (deleting it would merge paragraphs)
 * @example
 * planTextEdit(locateText(doc, "ready for review")!, "approved and final")
 */
export function planTextEdit(hit: LocatedText, replace: string, tabId?: string): EditTextPlan {
  if (hit.runs.some((r) => r.content.includes("\n"))) {
    throw new Error("docs_edit_text cannot change paragraph breaks — edit within one paragraph");
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

  const n = replace.length;
  const requests: Record<string, unknown>[] = [{ insertText: { location: location(s + 1), text: replace } }];
  if (e - s > 1) requests.push({ deleteContentRange: { range: range(s + 1 + n, e + n) } });
  requests.push({ deleteContentRange: { range: range(s, s + 1) } });
  return { ok: true, requests };
}
