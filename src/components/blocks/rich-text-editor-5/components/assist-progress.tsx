import { useId, type KeyboardEvent, type Ref } from "react"
import { FramePanel } from "@/components/reui/frame"
import { cn } from "cn"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
} from "@/components/ui/input-group"
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from "@/components/ui/marker"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { BAND_ITEM, DockBand, FOLD_OPEN } from "./assist-dock"
import { RequestLine, type AssistRequest } from "./assist-request"
import type { StreamProgress } from "./assist-stream"
import { AssistTile } from "./value-faces"
import { CheckIcon, ChevronUpIcon } from "lucide-react"

const EASE_OUT = [0.22, 1, 0.36, 1] as const

interface AssistProgressProps {
  request: AssistRequest
  steps: string[]
  /** Steps revealed so far; the last one shown is the live one. */
  shown: number
  progress: StreamProgress | null
  /** The full step list, folded up above the line on demand. */
  traceOpen: boolean
  onTraceOpenChange: (open: boolean) => void
  onStop: () => void
  stopRef?: Ref<HTMLButtonElement>
}

/** The live run on one line: the step shimmers while it works and the counter
 * tracks the edits; the text itself shows each word land. */
export function AssistProgress({
  request,
  steps,
  shown,
  progress,
  traceOpen,
  onTraceOpenChange,
  onStop,
  stopRef,
}: AssistProgressProps) {
  const reduce = useReducedMotion() ?? false
  const traceId = useId()
  const current = steps[shown - 1] ?? steps[0] ?? ""
  const counter =
    progress && progress.total > 1
      ? `${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
      : null

  // Escape folds the trace; it never stops the run.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !traceOpen || event.defaultPrevented) return
    event.preventDefault()
    onTraceOpenChange(false)
  }

  return (
    <div className="flex flex-col" onKeyDown={handleKeyDown}>
      <DockBand open={traceOpen} id={traceId} aria-label="Run steps">
        {/* Older rows glide up on the fold's spring as a new step lands. */}
        <motion.div
          layout="position"
          layoutDependency={shown}
          transition={reduce ? { duration: 0 } : FOLD_OPEN}
          className="flex flex-col gap-2"
        >
          <span className="text-muted-foreground text-xs">
            <RequestLine request={request} />
          </span>
          <ol className="flex flex-col gap-2">
            {steps.slice(0, shown).map((step, index) => {
              const live = index === shown - 1
              return (
                <motion.li
                  key={step}
                  variants={reduce ? undefined : BAND_ITEM}
                  initial={reduce ? false : "closed"}
                  animate="open"
                >
                  <Marker>
                    <MarkerIcon>
                      {live ? (
                        <Spinner role="presentation" aria-hidden="true" />
                      ) : (
                        <CheckIcon aria-hidden="true" />
                      )}
                    </MarkerIcon>
                    <MarkerContent className={cn(live && "text-foreground")}>
                      {step}
                    </MarkerContent>
                  </Marker>
                </motion.li>
              )
            })}
          </ol>
        </motion.div>
      </DockBand>

      <FramePanel className="p-0">
        {/* The composer's own row, so the tile keeps its slot across states. */}
        <InputGroup className="h-10 border-0 bg-transparent">
          <InputGroupAddon align="inline-start">
            <AssistTile />
          </InputGroupAddon>
          {/* The label rolls once per step, never per word; its inset matches the
              composer field's, so the text starts where "Ask Assist" did. */}
          <span className="relative flex h-5 min-w-0 flex-1 items-center overflow-hidden ps-2.5 text-sm font-medium">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={current}
                className="shimmer motion-reduce:shimmer-none block truncate [--shimmer-duration:2.4s]"
                initial={reduce ? false : { y: 8, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={reduce ? { opacity: 0 } : { y: -8, opacity: 0 }}
                transition={
                  reduce ? { duration: 0 } : { duration: 0.2, ease: EASE_OUT }
                }
              >
                {current}
              </motion.span>
            </AnimatePresence>
          </span>
          <InputGroupAddon align="inline-end" className="gap-1.5">
            {counter ? (
              <span className="text-muted-foreground text-xs tabular-nums">
                {counter}
              </span>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-expanded={traceOpen}
                    aria-controls={traceOpen ? traceId : undefined}
                    aria-label={traceOpen ? "Hide steps" : "Show steps"}
                    onClick={() => onTraceOpenChange(!traceOpen)}
                  />
                }
              >
                <motion.span
                  className="flex"
                  animate={{ rotate: traceOpen ? 180 : 0 }}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { type: "spring", visualDuration: 0.2, bounce: 0 }
                  }
                >
                  <ChevronUpIcon aria-hidden="true" />
                </motion.span>
              </TooltipTrigger>
              <TooltipContent>
                {traceOpen ? "Hide steps" : "Show steps"}
              </TooltipContent>
            </Tooltip>
            <Button
              ref={stopRef}
              type="button"
              variant="outline"
              size="xs"
              onClick={onStop}
            >
              <span aria-hidden="true" className="size-2 bg-current" />
              Stop
            </Button>
          </InputGroupAddon>
        </InputGroup>
        {/* Announced from outside the line, once per step and once per edit. */}
        <p role="status" aria-live="polite" className="sr-only">
          {counter ? `${current}, ${counter}` : current}
        </p>
      </FramePanel>
    </div>
  )
}