import { memo, useId, useRef } from "react"

import { Button } from "@/components/ui/button"
import { EmptyDescription, EmptyTitle } from "@/components/ui/empty"
import { GREETING, STARTERS } from "./data"
import { SCROLL_REGION, useScrollEdges } from "./scroll-region"
import { ChevronRightIcon } from "lucide-react"

/** A fresh chat opens here. Every row sends a real question, so the zero
    state is a way in rather than a poster. */
export const ChatStarters = memo(function ChatStarters({
  onSend,
}: {
  onSend: (prompt: string) => void
}) {
  const labelId = useId()
  const scrollerRef = useRef<HTMLDivElement>(null)
  useScrollEdges(scrollerRef)

  return (
    // Scrolls on its own once the rows outgrow a short window; pt-18 starts
    // the rows below the floating header and its fade.
    <div
      ref={scrollerRef}
      data-fold="starters"
      className={`${SCROLL_REGION} flex flex-col gap-5 px-4 pt-18 pb-2`}
    >
      <div className="flex flex-col gap-1">
        {/* The empty-state type pair, so the greeting reads like every chat's zero state. */}
        <EmptyTitle>{GREETING.title}</EmptyTitle>
        <EmptyDescription>{GREETING.lead}</EmptyDescription>
      </div>

      <div
        role="group"
        aria-labelledby={labelId}
        className="flex flex-col gap-1"
      >
        <p id={labelId} className="text-muted-foreground text-xs font-medium">
          Try Asking
        </p>
        <div className="flex flex-col">
          {STARTERS.map((prompt) => (
            <Button
              key={prompt}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onSend(prompt)}
              className="text-muted-foreground hover:text-foreground w-full justify-start gap-2 font-normal"
            >
              <ChevronRightIcon aria-hidden="true" />
              <span className="min-w-0 truncate">{prompt}</span>
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
})