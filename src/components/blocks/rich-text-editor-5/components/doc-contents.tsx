import { useRef, useState } from "react"
import type { Editor } from "@tiptap/react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useRichTextCount, useRichTextSelector } from "./rich-text-state"
import { keepEditorFocus } from "./rich-text-toolbar"
import { TableOfContentsIcon } from "lucide-react"

const NUMBER = new Intl.NumberFormat("en-US")

interface Heading {
  pos: number
  level: number
  text: string
}

function readHeadings(editor: Editor | null): Heading[] {
  const headings: Heading[] = []
  editor?.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return
    const text = node.textContent.trim()
    if (text) headings.push({ pos, level: Number(node.attrs.level), text })
    return false
  })
  return headings
}

/** Mounted per open, so a keystroke never re-counts a closed popover. */
function ContentsSummary({
  editor,
  sections,
}: {
  editor: Editor | null
  sections: number
}) {
  const { words, minutes } = useRichTextCount(editor)
  return (
    <PopoverDescription className="tabular-nums">
      {sections} {sections === 1 ? "section" : "sections"},{" "}
      {NUMBER.format(words)} {words === 1 ? "word" : "words"}
      {minutes > 0 ? `, ${minutes} min read` : ""}
    </PopoverDescription>
  )
}

/** The plan's headings as a jump list, with its length at the top. */
export function DocContents({ editor }: { editor: Editor | null }) {
  const [open, setOpen] = useState(false)
  const firstRef = useRef<HTMLButtonElement>(null)
  const headings = useRichTextSelector(editor, readHeadings)
  const top = Math.min(...headings.map((heading) => heading.level))

  // The caret lands in the heading and the heading rises to the top; its
  // scroll margin (doc-assistant.tsx) keeps it clear of the sticky header.
  function jump(pos: number) {
    if (!editor) return
    setOpen(false)
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .setTextSelection(pos + 1)
      .run()
    const target = editor.view.nodeDOM(pos)
    if (!(target instanceof HTMLElement)) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    target.scrollIntoView({
      block: "start",
      behavior: reduce ? "auto" : "smooth",
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        {/* The span carries the tooltip, so the trigger keeps its own props. */}
        <TooltipTrigger render={<span className="flex" />}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Contents"
                disabled={!headings.length}
                onMouseDown={keepEditorFocus}
                data-toolbar-item=""
              />
            }
          >
            <TableOfContentsIcon aria-hidden="true" />
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Contents</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="w-64"
        initialFocus={firstRef}
        finalFocus={() => editor?.view.dom ?? true}
      >
        <PopoverHeader>
          <PopoverTitle>Contents</PopoverTitle>
          <ContentsSummary editor={editor} sections={headings.length} />
        </PopoverHeader>
        <nav aria-label="Plan sections">
          <ul className="-mx-2 flex flex-col">
            {headings.map((heading, index) => (
              <li
                key={heading.pos}
                className={cn(heading.level > top && "ms-3")}
              >
                <Button
                  ref={index === 0 ? firstRef : undefined}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "w-full justify-start",
                    heading.level > top
                      ? "text-muted-foreground font-normal"
                      : "font-medium"
                  )}
                  onClick={() => jump(heading.pos)}
                >
                  <span className="truncate">{heading.text}</span>
                </Button>
              </li>
            ))}
          </ul>
        </nav>
      </PopoverContent>
    </Popover>
  )
}