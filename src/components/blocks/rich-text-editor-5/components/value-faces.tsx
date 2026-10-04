import { IconTile } from "@/components/reui/icon-tile"
import { cn } from "cn"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import { PEOPLE, type PersonId } from "./data"
import { SUGGESTION_TINTS, type SuggestionSummary } from "./rich-text-changes"
import { SparklesIcon } from "lucide-react"

/** The house dot separator. */
export function Dot() {
  return (
    <span
      aria-hidden="true"
      className="bg-muted-foreground/40 size-1 shrink-0 rounded-full"
    />
  )
}

/** The agent's one face, wherever it speaks. */
export function AssistTile({ className }: { className?: string }) {
  return (
    <IconTile
      variant="elevated"
      size="xs"
      radius="full"
      aria-hidden="true"
      className={cn("text-primary", className)}
    >
      <SparklesIcon aria-hidden="true" />
    </IconTile>
  )
}

export function PersonAvatar({
  id,
  className,
}: {
  id: PersonId
  className?: string
}) {
  const person = PEOPLE.find((candidate) => candidate.id === id)
  if (!person) return null

  return (
    <Avatar size="sm" className={className}>
      <AvatarImage src={person.avatar} alt={person.name} />
      <AvatarFallback>{person.initials}</AvatarFallback>
    </Avatar>
  )
}

// A replace often starts on a space; the excerpt shows the words themselves.
function excerptText(text: string) {
  return text.trim().replace(/^[,;:.]\s*/, "") || text
}

const LINE = "flex min-w-0 items-baseline gap-2"
const LINE_LABEL = "text-muted-foreground w-9 shrink-0 text-xs"

/** Was on one line, Now on up to two, so a rewrite shows its new words; the
 * label and the strike carry the meaning without colour. */
export function ChangeExcerpt({
  change,
  className,
}: {
  change: SuggestionSummary
  className?: string
}) {
  const deleted = excerptText(change.deleted)
  const inserted = excerptText(change.inserted)

  return (
    <span
      className={cn(
        SUGGESTION_TINTS,
        "flex min-w-0 flex-col gap-1 [&_ins]:underline-offset-2",
        className
      )}
    >
      {deleted ? (
        <span className={LINE}>
          <span className={LINE_LABEL}>{inserted ? "Was" : "Cut"}</span>
          <del className="truncate">{deleted}</del>
        </span>
      ) : null}
      {inserted ? (
        <span className={LINE}>
          <span className={LINE_LABEL}>{deleted ? "Now" : "Adds"}</span>
          <ins className="line-clamp-2 min-w-0">{inserted}</ins>
        </span>
      ) : null}
    </span>
  )
}