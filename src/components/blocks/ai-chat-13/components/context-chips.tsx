import {
  Attachment,
  AttachmentContent,
  AttachmentGroup,
  AttachmentTitle,
} from "@/components/ui/attachment"

import { SOURCES } from "./data"

/** What the assistant was given to read, shown under the question it went with. */
export function ContextChips({
  ids,
  className,
}: {
  ids: string[]
  className?: string
}) {
  const sources = SOURCES.filter((source) => ids.includes(source.id))
  if (sources.length === 0) return null

  return (
    <AttachmentGroup aria-label="Attached context" className={className}>
      {sources.map((source) => (
        <Attachment key={source.id} size="xs" className="max-w-48">
          {/* Bare: the chip already paints the surface a media box would. */}
          <span
            aria-hidden="true"
            className="text-muted-foreground shrink-0 [&>svg]:size-3.5"
          >
            {source.icon}
          </span>
          <AttachmentContent>
            <AttachmentTitle>{source.chip}</AttachmentTitle>
          </AttachmentContent>
        </Attachment>
      ))}
    </AttachmentGroup>
  )
}