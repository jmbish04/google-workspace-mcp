/**
 * @file shared/text-diff.ts
 * @description A word-level diff, used to show what changed between two
 * revisions of a draft. Small enough not to earn a dependency: revisions are
 * emails, so the inputs are kilobytes, not files.
 *
 * Classic LCS over tokens, where a token is a run of word characters or a
 * single punctuation/whitespace character — so "4,000" → "4,500" reports the
 * number as changed rather than the whole paragraph.
 */

export type DiffOp = "same" | "added" | "removed";
export interface DiffPart {
  op: DiffOp;
  value: string;
}

/** Split into diffable tokens, keeping whitespace so the result re-joins exactly. */
function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
}

/**
 * Word-level diff of two texts.
 *
 * Guards against a quadratic blow-up: the LCS table is O(n·m), so past
 * `maxTokens` on either side the two texts are reported as a wholesale
 * replacement rather than hanging the page. An email never hits that.
 */
export function diffWords(before: string, after: string, maxTokens = 4000): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > maxTokens || b.length > maxTokens) {
    const parts: DiffPart[] = [];
    if (before) parts.push({ op: "removed", value: before });
    if (after) parts.push({ op: "added", value: after });
    return parts;
  }

  // lcs[i][j] = length of the longest common subsequence of a[i…] and b[j…].
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffPart[] = [];
  const push = (op: DiffOp, value: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.value += value;
    else out.push({ op, value });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("removed", a[i++]);
    } else {
      push("added", b[j++]);
    }
  }
  while (i < a.length) push("removed", a[i++]);
  while (j < b.length) push("added", b[j++]);
  return out;
}

/** Counts for a one-line "+12 / −4 words" summary. */
export function diffSummary(parts: DiffPart[]): { added: number; removed: number } {
  const words = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    if (p.op === "added") added += words(p.value);
    else if (p.op === "removed") removed += words(p.value);
  }
  return { added, removed };
}
