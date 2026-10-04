import { useState, type Ref } from "react"
import {
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame"

import { Button } from "@/components/ui/button"
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/ui/button-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Item, ItemContent } from "@/components/ui/item"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { plural, type AssistSummary } from "./assist-plans"
import type {
  SuggestionResolution,
  SuggestionSummary,
} from "./rich-text-changes"
import { AssistTile, ChangeExcerpt, Dot } from "./value-faces"
import { XIcon, ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon, CheckCheckIcon, CircleXIcon, CheckIcon } from "lucide-react"

interface AssistReviewProps {
  summary: AssistSummary
  changes: SuggestionSummary[]
  /** The change the caret sits in, or null. */
  activeId: string | null
  onReveal: (id: string) => void
  onResolve: (id: string, resolution: SuggestionResolution) => void
  onResolveAll: (resolution: SuggestionResolution) => void
  onLater: () => void
  acceptRef?: Ref<HTMLButtonElement>
}

/** One edit at a time: what changed, where it sits, keep it or drop it. */
export function AssistReview({
  summary,
  changes,
  activeId,
  onReveal,
  onResolve,
  onResolveAll,
  onLater,
  acceptRef,
}: AssistReviewProps) {
  // Announced after a step only, so the counter stays quiet while typing.
  const [announcement, setAnnouncement] = useState("")
  const index = Math.max(
    0,
    changes.findIndex((change) => change.id === activeId)
  )
  const current = changes[index]
  const total = changes.length

  if (!current) return null

  function step(direction: 1 | -1) {
    const next = changes[(index + direction + total) % total]
    if (!next) return
    onReveal(next.id)
    setAnnouncement(`Edit ${changes.indexOf(next) + 1} of ${total}`)
  }

  return (
    <>
      <FrameHeader className="flex-row items-center gap-2">
        <AssistTile />
        <FrameTitle className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate">{summary.title}</span>
          <Dot />
          <span className="text-muted-foreground shrink-0 text-xs font-normal tabular-nums">
            {summary.detail ?? plural(total, "edit")}
          </span>
        </FrameTitle>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                aria-label="Review later"
                onClick={onLater}
              />
            }
          >
            <XIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Review later</TooltipContent>
        </Tooltip>
      </FrameHeader>

      <FramePanel className="flex flex-col gap-3">
        {/* The excerpt opens the change in the page, where it reads in context. */}
        <Item
          size="xs"
          render={<button type="button" onClick={() => onReveal(current.id)} />}
          className="hover:bg-muted/60 cursor-pointer text-start"
        >
          <ItemContent className="min-w-0 text-sm">
            <ChangeExcerpt change={current} />
          </ItemContent>
        </Item>
        <div className="flex flex-wrap items-center gap-2">
          {total > 1 ? (
            <>
              <ButtonGroup aria-label="Edits">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label="Previous edit"
                        onClick={() => step(-1)}
                      />
                    }
                  >
                    <ChevronLeftIcon aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>Previous edit</TooltipContent>
                </Tooltip>
                <ButtonGroupText className="min-w-16 justify-center text-xs tabular-nums">
                  {index + 1} of {total}
                </ButtonGroupText>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label="Next edit"
                        onClick={() => step(1)}
                      />
                    }
                  >
                    <ChevronRightIcon aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>Next edit</TooltipContent>
                </Tooltip>
              </ButtonGroup>
              <span role="status" className="sr-only">
                {announcement}
              </span>
            </>
          ) : null}
          <div className="ms-auto flex items-center gap-2">
            {total > 1 ? (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="All edits"
                          />
                        }
                      />
                    }
                  >
                    <MoreHorizontalIcon aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>All edits</TooltipContent>
                </Tooltip>
                <DropdownMenuContent side="top" align="end" className="w-48">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>
                      All {plural(total, "Edit")}
                    </DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => onResolveAll("accept")}>
                      <CheckCheckIcon aria-hidden="true" />
                      Accept All
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => onResolveAll("reject")}
                    >
                      <CircleXIcon aria-hidden="true" />
                      Reject All
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onResolve(current.id, "reject")}
            >
              <XIcon data-icon="inline-start" aria-hidden="true" />
              Reject
            </Button>
            <Button
              ref={acceptRef}
              type="button"
              size="sm"
              onClick={() => onResolve(current.id, "accept")}
            >
              <CheckIcon data-icon="inline-start" aria-hidden="true" />
              Accept
            </Button>
          </div>
        </div>
      </FramePanel>
    </>
  )
}