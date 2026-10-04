/**
 * @fileoverview NotesEditor — the editable Tiptap rich-text island for a team
 * note's body. Mounted via `client:only="react"` (Tiptap / ProseMirror rely on
 * browser-only DOM APIs and must never run during Astro SSR).
 *
 * Built from the ReUI rich-text-editor-1 kit AS SHIPPED (same composition as
 * the draft studio's BodyEditor): `FormattingToolbar` + `RichTextContent` +
 * `RichTextLinkBubble` over `createRichTextExtensions`. No hand-rolled
 * toolbar, no locally re-implemented menu; theme via design tokens only.
 *
 * The component is "controlled-ish": it seeds the editor from a stored `body`
 * string once, and pushes every change back out as a fresh `body` string via
 * `onChange`, so the parent dialog can persist exactly what it needs without
 * understanding the Tiptap document shape. Stored bodies are decoded /
 * re-encoded by `notes-value.ts` (new saves use the v2 Tiptap envelope; old
 * Plate v1 envelopes load through the plain-text fallback).
 */

"use client";

import { useEditor, type JSONContent } from "@tiptap/react";
import { useMemo, useState } from "react";

import type { TiptapDoc } from "@/shared/tiptap-email";

import { FormattingToolbar } from "@/components/blocks/rich-text-editor-1/components/formatting-toolbar";
import { RichTextContent } from "@/components/blocks/rich-text-editor-1/components/rich-text-content";
import { createRichTextExtensions } from "@/components/blocks/rich-text-editor-1/components/rich-text-extensions";
import { RichTextLinkBubble } from "@/components/blocks/rich-text-editor-1/components/rich-text-link";
import { useRichTextSelector } from "@/components/blocks/rich-text-editor-1/components/rich-text-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { bodyToTiptapDoc, tiptapDocToBody } from "./notes-value";

export interface NotesEditorProps {
  /** The currently stored `body` string (rich-text envelope or legacy text). */
  value: string;
  /** Called with a fresh `body` string on every edit. */
  onChange: (body: string) => void;
  /** Accessible label / placeholder for the empty editor. */
  placeholder?: string;
  /** Optional id for label association. */
  id?: string;
  className?: string;
  /** Extra classes for the editable content area (e.g. min-height overrides). */
  contentClassName?: string;
}

/**
 * Module scope default: useEditor compares the extension array by identity
 * each render, so the preset for the default placeholder must be a stable
 * constant; non-default placeholders get a memoized per-instance preset.
 */
const NOTES_EXTENSIONS = createRichTextExtensions({ placeholder: "Write the note…" });

/**
 * The editable Tiptap surface. `useEditor` memoizes the editor instance; we
 * seed it from `value` exactly once (the dialog remounts the editor when it
 * opens, which re-seeds it for the note being edited).
 */
export function NotesEditor({
  value,
  onChange,
  placeholder = "Write the note…",
  id,
  className,
  contentClassName,
}: NotesEditorProps) {
  // Read once, when the editor is created (the parent re-keys per open).
  // Legacy Plate envelopes degrade to plain text here — never a crash.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once; hosts key the component to re-seed.
  const initialDoc = useMemo<JSONContent>(() => bodyToTiptapDoc(value), []);

  // Per-instance extension preset: useEditor compares the array by identity
  // every render, so it must be memoized on the (stable) placeholder.
  const extensions = useMemo(
    () =>
      placeholder === "Write the note…"
        ? NOTES_EXTENSIONS
        : createRichTextExtensions({ placeholder }),
    [placeholder],
  );

  const [linkOpen, setLinkOpen] = useState(false);

  const editor = useEditor({
    extensions,
    content: initialDoc,
    editorProps: {
      attributes: { "aria-label": placeholder, "aria-multiline": "true", ...(id ? { id } : {}) },
    },
    immediatelyRender: false,
    onUpdate: ({ editor: current }) => {
      onChange(tiptapDocToBody(current.getJSON() as TiptapDoc));
    },
  });

  const editable = useRichTextSelector(editor, (current) => current?.isEditable ?? true);

  // Mod-K follows the toolbar: no link where marks are refused (code blocks).
  function openLinkFromKeyboard() {
    setLinkOpen(editable && Boolean(editor?.can().toggleBold()));
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md bg-input/30 ring-1 ring-border/40 focus-within:ring-2 focus-within:ring-ring/50",
        className,
      )}
    >
      <TooltipProvider delay={300}>
        <FormattingToolbar editor={editor} linkOpen={linkOpen} onLinkOpenChange={setLinkOpen} />
        <div className={cn("relative max-h-[22rem] min-h-40 overflow-y-auto", contentClassName)}>
          <RichTextContent
            editor={editor}
            onLinkShortcut={openLinkFromKeyboard}
            className="px-3 py-2.5"
          />
          {editor ? <RichTextLinkBubble editor={editor} onEdit={() => setLinkOpen(true)} /> : null}
        </div>
      </TooltipProvider>
    </div>
  );
}

export default NotesEditor;
