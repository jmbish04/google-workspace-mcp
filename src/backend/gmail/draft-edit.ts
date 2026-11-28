/**
 * @file gmail/draft-edit.ts
 * @description Pure merge logic for `gmail_update_draft`. Gmail has no partial
 * draft update — `PUT users/me/drafts/{id}` replaces the whole message — so an
 * edit is get → merge → rebuild → put. This module owns the MERGE step: folding a
 * body edit (replace | append | prepend) into the draft's stored HTML, and
 * de-duplicating Cc/Bcc additions. The rebuilt body is always handed back to
 * `composeBody` (via `buildOutgoingRaw`) rather than string-replaced, so the
 * hidden `ref:<uuid>` marker and `cid:` image bindings survive. No network; this
 * module is fully testable on its own.
 */
import { parse, type HTMLElement } from "node-html-parser";

import { markdownToGmailHtml, textToHtml } from "@/backend/gmail/compose";
import { parseAddress, splitAddresses } from "@/backend/gmail/parse-message";

/** How a body edit is applied to the draft's existing body. */
export type DraftBodyMode = "replace" | "append" | "prepend";

/** New body content for an edit — at most one of markdown / html / text. */
export interface DraftBodyContent {
  markdown?: string;
  html?: string;
  text?: string;
}

/** A body input ready for `composeBody` (priority markdown → html → text). */
export type DraftBodyInput = DraftBodyContent;

/** True when the edit carries actual new body content (not just header changes). */
export function hasBodyContent(c: DraftBodyContent): boolean {
  return [c.markdown, c.html, c.text].some((v) => v != null && v !== "");
}

/**
 * Strip the house `<div dir="ltr">` wrapper and return the inner HTML. Append and
 * prepend MUST merge on the unwrapped inner: concatenating two wrapped bodies
 * nests one wrapper inside another, because `composeBody` only unwraps a single
 * top-level `dir="ltr"` div. A body that is not wrapped is returned unchanged.
 */
export function unwrapBody(html: string): string {
  const root = parse(html, { comment: false });
  const kids = root.childNodes.filter((n) => n.nodeType === 1 || n.textContent.trim());
  const only = kids.length === 1 && kids[0].nodeType === 1 ? (kids[0] as HTMLElement) : undefined;
  if (only && only.tagName?.toLowerCase() === "div" && only.getAttribute("dir") === "ltr") {
    return only.innerHTML;
  }
  return html;
}

/** Render new body content to an HTML fragment (markdown/text → HTML; html as-is). */
function toHtmlFragment(c: DraftBodyContent): string {
  if (c.markdown) return markdownToGmailHtml(c.markdown);
  if (c.html) return c.html;
  return textToHtml(c.text ?? "");
}

/**
 * Compute the body input to hand `composeBody` for a draft update.
 *
 * - no new content → re-compose the stored HTML unchanged (idempotent — keeps the
 *   one hidden ref marker and makes a header-only edit a body no-op)
 * - `replace` → the new content on its own
 * - `append` / `prepend` → the stored INNER html concatenated with the rendered
 *   new fragment, handed back as `html`
 */
export function mergeDraftBody(
  storedHtml: string,
  mode: DraftBodyMode,
  content: DraftBodyContent,
): DraftBodyInput {
  if (!hasBodyContent(content)) return { html: storedHtml };
  if (mode === "replace") return { ...content };
  const inner = unwrapBody(storedHtml);
  const fragment = toHtmlFragment(content);
  return { html: mode === "append" ? `${inner}${fragment}` : `${fragment}${inner}` };
}

/**
 * Append `add` addresses to a comma-separated Cc/Bcc header, de-duplicated
 * case-insensitively by email address. An address already present in any
 * display-name form (`"A B" <a@x>` vs `a@x`) is not added again, and an entry
 * with no parseable email is skipped rather than written as garbage. This is the
 * one-call `addCc` / `addBcc` path for the reported bug: adding a Cc to an
 * existing draft without first reading and re-sending the whole list.
 */
export function mergeAddresses(baseHeader: string, add: string[]): string {
  const existing = splitAddresses(baseHeader || "");
  const seen = new Set(
    existing.map((a) => parseAddress(a)?.email).filter((e): e is string => Boolean(e)),
  );
  const out = [...existing];
  for (const entry of add) {
    const email = parseAddress(entry)?.email;
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(entry.trim());
  }
  return out.join(", ");
}
