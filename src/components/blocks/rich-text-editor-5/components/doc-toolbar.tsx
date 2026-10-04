import type { Editor } from "@tiptap/react"
import { AGENT } from "./data"
import { DocContents } from "./doc-contents"
import {
  RichTextAlignMenu,
  RichTextBlockToggles,
  RichTextBlockTypeMenu,
  RichTextHistory,
  RichTextListToggles,
  RichTextMarkToggles,
} from "./rich-text-controls"
import { RichTextHighlightPopover } from "./rich-text-highlight"
import { RichTextLinkPopover } from "./rich-text-link"
import { useRichTextState } from "./rich-text-state"
import {
  RichTextButton,
  RichTextToolbar,
  RichTextToolbarGroup,
  RichTextToolbarSeparator,
} from "./rich-text-toolbar"
import { SparklesIcon } from "lucide-react"

interface DocToolbarProps {
  editor: Editor | null
  /** Hands the selection, or the whole plan, to the Assist line. */
  onAsk: () => void
  askDisabled: boolean
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
}

/** The kit's full bar, centered over the page; auto margins center it while
 * it fits and collapse to zero once it scrolls, so no end is ever clipped. */
export function DocToolbar({
  editor,
  onAsk,
  askDisabled,
  linkOpen,
  onLinkOpenChange,
}: DocToolbarProps) {
  const state = useRichTextState(editor)

  return (
    <RichTextToolbar
      aria-label="Formatting"
      className="min-w-0 flex-1 [&>:first-child]:ms-auto [&>:last-child]:me-auto"
    >
      <RichTextHistory editor={editor} state={state} />
      <RichTextToolbarSeparator />
      <RichTextBlockTypeMenu editor={editor} state={state} />
      <RichTextToolbarSeparator />
      <RichTextMarkToggles editor={editor} state={state} />
      <RichTextToolbarGroup label="Annotate">
        <RichTextHighlightPopover editor={editor} state={state} />
        <RichTextLinkPopover
          editor={editor}
          state={state}
          open={linkOpen}
          onOpenChange={onLinkOpenChange}
        />
      </RichTextToolbarGroup>
      <RichTextToolbarSeparator />
      <RichTextListToggles editor={editor} state={state} />
      <RichTextBlockToggles editor={editor} state={state} />
      <RichTextToolbarSeparator />
      <RichTextAlignMenu editor={editor} state={state} />
      <RichTextToolbarSeparator />
      <RichTextToolbarGroup label="Plan">
        <DocContents editor={editor} />
        <RichTextButton
          label={`Ask ${AGENT.name}`}
          disabled={askDisabled}
          onClick={onAsk}
        >
          <SparklesIcon aria-hidden="true" />
        </RichTextButton>
      </RichTextToolbarGroup>
    </RichTextToolbar>
  )
}