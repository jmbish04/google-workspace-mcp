/**
 * @fileoverview Barrel for the Tiptap notes editor feature.
 *
 * - `NotesEditor` — editable island (mount `client:only="react"`).
 * - `NotesBody`   — read-only render for list/preview cards.
 * - serialization helpers bridge the Tiptap document and the team-notes `body`
 *   string column (legacy Plate envelopes + plain text handled transparently
 *   via the plain-text fallback).
 */

export { NotesEditor, type NotesEditorProps } from "./NotesEditor";
export { NotesBody, type NotesBodyProps } from "./NotesBody";
export {
  bodyToSnippet,
  bodyToTiptapDoc,
  emptyTiptapDoc,
  plainTextToTiptapDoc,
  plateValueToPlainText,
  tiptapDocToBody,
  tiptapDocToPlainText,
} from "./notes-value";
