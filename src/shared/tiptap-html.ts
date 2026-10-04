/**
 * @file shared/tiptap-html.ts
 * @description The HTML → Tiptap parser (`htmlToTiptap`) built on
 * `@tiptap/html`'s `generateJSON`, plus re-exports of the email serialiser.
 *
 * `generateJSON` is the inverse of the draft studio's send path: it parses a
 * stored Gmail-HTML revision back into the Tiptap document the editor would
 * hold. In production the live browser editor does this parse itself, so this
 * runs only in Node — the round-trip test and any server-side reference. That
 * matters because `@tiptap/html/server` pulls `happy-dom`, which cannot run in
 * a Cloudflare Worker (see `tiptap-email.ts` for the measured reason). Nothing
 * on the Worker or in the browser bundle imports this module: the backend
 * serialises with `tiptapToHtml` from `tiptap-email.ts`, and the frontend seeds
 * the editor from `stripHiddenMarkers` there — neither touches `happy-dom`.
 */
import { generateJSON } from "@tiptap/html/server";
import { StarterKit } from "@tiptap/starter-kit";

import { isBlankParagraph, stripHiddenMarkers, type TiptapDoc } from "./tiptap-email";

export type { TiptapDoc, TiptapNode } from "./tiptap-email";
export { tiptapToHtml, serializeEmailDoc, toEmailDoc, stripHiddenMarkers } from "./tiptap-email";

/**
 * The parse schema. StarterKit v3 carries Link, Underline, Strike, Code, the
 * heading levels, both list kinds, blockquote, code blocks, hard breaks and
 * horizontal rules — the whole email-appropriate set — so a single clean
 * StarterKit is all `generateJSON` needs.
 */
export const EMAIL_EXTENSIONS = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: { openOnClick: false, defaultProtocol: "https" },
  }),
];

/**
 * HTML → Tiptap doc. Accepts the Gmail-native bodies this Worker produces (a
 * `<div dir="ltr">` wrapper of paragraphs): StarterKit has no rule for the
 * wrapper `<div>`, so `generateJSON` parses its children in context and the
 * paragraphs become the top level. Hidden machine markers are removed first,
 * and blank spacer paragraphs (Gmail's paragraph gap) are dropped so the result
 * matches the visible body.
 */
export function htmlToTiptap(html: string): TiptapDoc {
  const doc = generateJSON(stripHiddenMarkers(html ?? ""), EMAIL_EXTENSIONS) as TiptapDoc;
  const content = (doc.content ?? []).filter((n) => n.type !== "paragraph" || !isBlankParagraph(n));
  if (!content.length) return { type: "doc", content: [{ type: "paragraph" }] };
  return { type: "doc", content };
}
