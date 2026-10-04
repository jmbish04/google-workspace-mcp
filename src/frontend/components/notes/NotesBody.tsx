/**
 * @fileoverview NotesBody — a lightweight, read-only render of a saved note
 * `body`. Used by the notes list cards so we get faithful rich-text output
 * (headings, lists, quotes, code, links) without mounting the full editor.
 *
 * Like the editor, Tiptap touches browser-only APIs, so any host page must
 * mount this with `client:only="react"`. The notes list island is already a
 * client-only island, so importing it there is fine.
 *
 * Stored bodies are decoded by `notes-value.ts`: v2 Tiptap envelopes render as
 * authored, legacy Plate v1 envelopes and plain-text bodies degrade to
 * paragraphs — so old notes render as clean prose.
 *
 * `lineClamp` truncates the rendered output for card previews; pass `false`
 * for a full read view.
 */

"use client";

import { EditorContent, useEditor } from "@tiptap/react";
import { useMemo } from "react";

import { createRichTextExtensions } from "@/components/blocks/rich-text-editor-1/components/rich-text-extensions";
import { cn } from "@/lib/utils";

import { bodyToTiptapDoc } from "./notes-value";

export interface NotesBodyProps {
  /** Stored `body` string (rich-text envelope or legacy plain text). */
  body: string;
  /** Clamp the preview to N lines (default 4). Pass `false` to disable. */
  lineClamp?: number | false;
  className?: string;
}

const CLAMP_CLASS: Record<number, string> = {
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
  5: "line-clamp-5",
  6: "line-clamp-6",
};

/**
 * Module scope: useEditor compares the extension array by identity each
 * render, so the preset must be a stable constant.
 */
const RENDER_EXTENSIONS = createRichTextExtensions({ placeholder: "" });

/**
 * Read-only Tiptap render of a note body. A non-editable Tiptap instance
 * renders the decoded document with the kit's own prose styles
 * (`RICH_TEXT_PROSE`), so saved notes render identically to how they were
 * authored.
 */
export function NotesBody({ body, lineClamp = 4, className }: NotesBodyProps) {
  const doc = useMemo(() => bodyToTiptapDoc(body), [body]);
  const clamp = typeof lineClamp === "number" ? CLAMP_CLASS[lineClamp] : undefined;

  const editor = useEditor({
    extensions: RENDER_EXTENSIONS,
    content: doc,
    editable: false,
    editorProps: { attributes: { "aria-label": "Note body preview", "aria-readonly": "true" } },
    immediatelyRender: false,
  });

  return (
    <div className={cn("text-sm text-muted-foreground", clamp, className)}>
      {editor ? (
        <EditorContent editor={editor} className="[&_.tiptap]:outline-none [&_*]:cursor-default" />
      ) : null}
    </div>
  );
}

export default NotesBody;
