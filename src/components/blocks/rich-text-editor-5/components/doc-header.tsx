import type { Ref } from "react"
import { Badge } from "@/components/reui/badge"
import type { Editor } from "@tiptap/react"

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarImage,
} from "@/components/ui/avatar"
import { Separator } from "@/components/ui/separator"

import { DOC_META, PEOPLE } from "./data"
import { DocMenu, SharePopover, ViewSelect } from "./doc-actions"
import { DocToolbar } from "./doc-toolbar"
import type { RichTextMarkupView } from "./rich-text-changes"
import { Dot } from "./value-faces"

// Local midnight, so the stored day never shifts with the viewer's time zone.
const EDITED_ON = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
}).format(new Date(`${DOC_META.editedAt}T00:00:00`))

const OWNER = PEOPLE.find((person) => person.id === DOC_META.ownerId)

const SHARED_WITH = `Shared with ${new Intl.ListFormat("en-US").format(
  PEOPLE.map((person) => person.name)
)}`

interface DocHeaderProps {
  ref?: Ref<HTMLElement>
  editor: Editor | null
  /** Suggestions waiting in the text, from any run. */
  pending: number
  /** The text changed in this session, so the stored stamp is stale. */
  edited: boolean
  /** How suggestions read in the page. */
  markup: RichTextMarkupView
  onMarkupChange: (view: RichTextMarkupView) => void
  /** Hands the selection to Assist. */
  onAsk: () => void
  askDisabled: boolean
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
}

/** One sticky band on the page: who and what above, formatting below. */
export function DocHeader({
  ref,
  editor,
  pending,
  edited,
  markup,
  onMarkupChange,
  onAsk,
  askDisabled,
  linkOpen,
  onLinkOpenChange,
}: DocHeaderProps) {
  const view = {
    view: markup,
    onViewChange: onMarkupChange,
    disabled: !pending,
  }
  return (
    <header ref={ref} className="bg-background sticky top-0 z-20 border-b">
      <div className="flex min-h-14 items-center gap-3 px-4 py-2 sm:px-6">
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base/5 font-medium">
              {DOC_META.title}
            </h1>
            {pending > 0 ? (
              <Badge variant="primary-light" className="shrink-0 tabular-nums">
                {pending} {pending === 1 ? "suggestion" : "suggestions"}
              </Badge>
            ) : null}
          </div>
          {/* Each dot travels inside its segment, so a wrap never strands one. */}
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
            <span>{DOC_META.kind}</span>
            {OWNER ? (
              <span className="inline-flex items-center gap-1.5 max-sm:hidden">
                <Dot />
                {OWNER.name}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5">
              <Dot />
              Edited {edited ? "just now" : EDITED_ON}
            </span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <AvatarGroup
            role="group"
            aria-label={SHARED_WITH}
            className="max-sm:hidden"
          >
            {PEOPLE.map((person) => (
              <Avatar key={person.id} size="sm">
                <AvatarImage src={person.avatar} alt={person.name} />
                <AvatarFallback>{person.initials}</AvatarFallback>
              </Avatar>
            ))}
          </AvatarGroup>
          <Separator
            orientation="vertical"
            className="h-5 data-vertical:self-center max-sm:hidden"
          />
          <div className="max-md:hidden">
            <ViewSelect {...view} />
          </div>
          <SharePopover />
          <DocMenu editor={editor} {...view} />
        </div>
      </div>

      <div className="flex items-center border-t px-4 py-2 sm:px-6">
        <DocToolbar
          editor={editor}
          onAsk={onAsk}
          askDisabled={askDisabled}
          linkOpen={linkOpen}
          onLinkOpenChange={onLinkOpenChange}
        />
      </div>
    </header>
  )
}