/**
 * @fileoverview TaskRichEditor — the editable Tiptap rich-text island shared by
 * the task DESCRIPTION (intake dialog + viewport) and task COMMENTS.
 *
 * Built from the ReUI rich-text-editor-1 kit AS SHIPPED (same composition as
 * the draft studio's BodyEditor): `FormattingToolbar` + `RichTextContent` +
 * `RichTextLinkBubble` over `createRichTextExtensions`. No hand-rolled toolbar.
 *
 * The stored value stays an HTML string, so this editor bridges to it exactly
 * as the PlateJS editor did: it DESERIALIZES the incoming HTML fragment into a
 * Tiptap document on load (the live browser editor parses the HTML itself),
 * and on every change SERIALIZES the document back to **sanitized HTML**
 * (`tiptapToHtml` → `sanitizeHtml`) via `onChangeHtml`, so `tasks.description`
 * / `task_comments.body` hold render-ready HTML with no schema change.
 *
 * On load it handles the three legacy storage forms transparently:
 *   (a) an HTML fragment (Round 3+)        → parsed by the browser editor.
 *   (b) a Plate envelope `{v,format,value}` → PLAIN-TEXT FALLBACK: the Slate
 *       nodes are flattened to text and lifted into paragraphs (see
 *       `task-html.ts#plateEnvelopeToPlainText`). Never crashes.
 *   (c) plain text / markdown (Round 1)     → handed to the editor's own
 *       parser, which lifts it into paragraph(s).
 *
 * SSR: Tiptap/ProseMirror touch browser-only DOM APIs. The host mounts this
 * inside a `client:load` island and callers additionally gate it behind a
 * `mounted` flag (rendering a placeholder until then) so it never runs during
 * Astro SSR / first hydration paint (avoiding React #418/#425).
 */

"use client";

import { useCallback, useMemo, useState } from "react";
import { useEditor, type Editor } from "@tiptap/react";

import { FormattingToolbar } from "@/components/blocks/rich-text-editor-1/components/formatting-toolbar";
import { RichTextContent } from "@/components/blocks/rich-text-editor-1/components/rich-text-content";
import { createRichTextExtensions } from "@/components/blocks/rich-text-editor-1/components/rich-text-extensions";
import { RichTextLinkBubble } from "@/components/blocks/rich-text-editor-1/components/rich-text-link";
import { useRichTextSelector } from "@/components/blocks/rich-text-editor-1/components/rich-text-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { tiptapToHtml, type TiptapDoc } from "@/shared/tiptap-email";

import { plateEnvelopeToPlainText } from "./task-html";
import { sanitizeHtml } from "./sanitize-html";

export interface TaskRichEditorProps {
  /** The currently stored content string (HTML, Plate envelope, or plain text). */
  valueHtml: string;
  /** Called with a fresh SANITIZED HTML string on every edit. */
  onChangeHtml: (html: string) => void;
  /** Accessible label / placeholder for the empty editor. */
  placeholder?: string;
  /** Optional id for label association. */
  id?: string;
  /** Extra classes for the outer editor shell. */
  className?: string;
  /** Extra classes for the editable content area (e.g. min-height overrides). */
  contentClassName?: string;
}

/** Escape the five HTML-significant characters in text content. */
function escapeForHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Resolve a stored content string into initial editor content.
 *
 * Tiptap's editor accepts an HTML string as content and parses it in the
 * browser, so the HTML fragment case needs no headless parse here. The only
 * transformation required is the legacy Round-2 Plate envelope, which
 * degrades to plain text (blank lines split paragraphs) through
 * `plateEnvelopeToPlainText`.
 */
function storedToInitialContent(stored: string): string {
  const raw = stored ?? "";
  if (!raw.trim()) return "<p></p>";

  // (b) Round-2 Plate envelope → plain-text fallback.
  const plateText = plateEnvelopeToPlainText(raw);
  if (plateText != null) {
    return plateText
      .split(/\n{2,}/)
      .map((para) => `<p>${escapeForHtml(para.replace(/\n+/g, " "))}</p>`)
      .join("");
  }

  // (a) HTML fragment / (c) plain text — hand both to the browser editor's own
  // parser. Plain text with no tags parses into paragraph nodes; stray `<`
  // in plain text is treated as text by ProseMirror's parser.
  return raw;
}

/**
 * Editable Tiptap surface that reads/writes a stored content string as HTML.
 * The editor is seeded once from `valueHtml`; hosts remount it (e.g. by keying
 * the dialog) when they need to re-seed for a different task/comment.
 */
export function TaskRichEditor({
  valueHtml,
  onChangeHtml,
  placeholder = "Write…",
  id,
  className,
  contentClassName,
}: TaskRichEditorProps) {
  // Compute the initial content once from the incoming stored string (handles
  // the HTML / envelope / plain-text forms). `useEditor` memoizes the editor,
  // so this seeds it exactly once; hosts remount to re-seed.
  const initialContent = useMemo(
    () => storedToInitialContent(valueHtml),
    // Seed once on mount; hosts key the component to force a re-seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once; hosts re-key to re-seed.
    [],
  );

  // Per-instance extension preset: useEditor compares the array by identity
  // every render, so it must be memoized on the (stable) placeholder.
  const extensions = useMemo(
    () => createRichTextExtensions({ placeholder }),
    [placeholder],
  );

  const [linkOpen, setLinkOpen] = useState(false);

  const handleChange = useCallback(
    ({ editor, transaction }: { editor: Editor; transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      const html = tiptapToHtml(editor.getJSON() as TiptapDoc);
      onChangeHtml(sanitizeHtml(html));
    },
    [onChangeHtml],
  );

  const editor = useEditor({
    extensions,
    content: initialContent,
    editorProps: {
      attributes: { "aria-label": placeholder, "aria-multiline": "true", ...(id ? { id } : {}) },
    },
    immediatelyRender: false,
    onUpdate: handleChange,
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
        <div className={cn("relative max-h-[22rem] min-h-32 overflow-y-auto", contentClassName)}>
          <RichTextContent editor={editor} onLinkShortcut={openLinkFromKeyboard} className="px-3 py-2.5" />
          {editor ? <RichTextLinkBubble editor={editor} onEdit={() => setLinkOpen(true)} /> : null}
        </div>
      </TooltipProvider>
    </div>
  );
}

export default TaskRichEditor;