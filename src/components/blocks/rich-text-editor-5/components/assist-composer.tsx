import {
  Fragment,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react"
import { FramePanel } from "@/components/reui/frame"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { DockBand } from "./assist-dock"
import {
  AGENT,
  ASSIST_ACTIONS,
  ASSIST_GROUPS,
  type AssistActionId,
} from "./data"
import { AssistTile } from "./value-faces"
import { CircleCheckIcon, XIcon, ChevronUpIcon, HighlighterIcon, FileTextIcon, ArrowUpIcon } from "lucide-react"

const ROW = {
  on: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
  },
  off: { opacity: 0, y: 4, transition: { duration: 0.12 } },
} as const

const ROW_STILL = {
  on: { opacity: 1, transition: { duration: 0 } },
  off: { opacity: 0, transition: { duration: 0 } },
} as const

const GLIDE = { type: "spring", visualDuration: 0.22, bounce: 0 } as const

/** The last review decision; Undo takes it back in one step. */
export interface AssistOutcome {
  text: string
}

interface AssistComposerProps {
  value: string
  onValueChange: (value: string) => void
  onSubmit: (prompt: string) => void
  onRun: (id: AssistActionId) => void
  /** "Whole plan", or the selection the next run is limited to. */
  scopeLabel: string
  scoped: boolean
  /** One live fact per task, read when the menu opens. */
  readouts: Partial<Record<AssistActionId, string>>
  onMenuOpenChange: (open: boolean) => void
  /** Suggestions left for later; the button reopens their review. */
  pending: number
  onReview: () => void
  outcome: AssistOutcome | null
  onUndo: () => void
  onDismissOutcome: () => void
  fieldRef: RefObject<HTMLTextAreaElement | null>
  /** Set before a focus handoff that should not unfold the band. */
  quietFocusRef: RefObject<boolean>
}

/** One quiet line at rest; the task band folds up out of it on demand. */
export function AssistComposer({
  value,
  onValueChange,
  onSubmit,
  onRun,
  scopeLabel,
  scoped,
  readouts,
  onMenuOpenChange,
  pending,
  onReview,
  outcome,
  onUndo,
  onDismissOutcome,
  fieldRef,
  quietFocusRef,
}: AssistComposerProps) {
  const reduce = useReducedMotion() ?? false
  const fieldId = useId()
  const menuId = useId()
  const scopeId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const outcomeRef = useRef<HTMLDivElement>(null)
  const menuOpenRef = useRef(false)
  const actionRef = useRef<(() => void) | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sending, setSending] = useState(false)

  const typed = value.trim().length > 0
  const open = !sending && (expanded || typed || menuOpen)
  const bandOpen = !sending && (open || outcome !== null)

  // Deferred: Base UI and the Radix modal menu hand focus back at different
  // moments, so the check reads where focus settled.
  function recheck() {
    window.setTimeout(() => {
      const active = document.activeElement
      const inside =
        rootRef.current?.contains(active) ||
        active?.closest("[data-slot=dropdown-menu-content]")
      if (!inside && !menuOpenRef.current) setExpanded(false)
    }, 0)
  }

  // The band folds shut first, then the run or answer takes the dock.
  function dispatchAfterFold(action: () => void) {
    if (actionRef.current) return
    if (!bandOpen) {
      action()
      return
    }
    actionRef.current = action
    setSending(true)
  }

  function handleFolded() {
    const action = actionRef.current
    actionRef.current = null
    setSending(false)
    action?.()
  }

  function focusFieldQuietly() {
    if (document.activeElement === fieldRef.current) return
    quietFocusRef.current = true
    fieldRef.current?.focus({ preventScroll: true })
  }

  function submit(event?: FormEvent) {
    event?.preventDefault()
    const prompt = value.trim()
    if (!prompt) {
      fieldRef.current?.focus()
      return
    }
    dispatchAfterFold(() => onSubmit(prompt))
  }

  // Enter sends, Shift+Enter breaks the line; an IME pick never sends.
  function handleFieldKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return
    }
    event.preventDefault()
    submit()
  }

  // React bubbles keys from the portaled menu, so containment is checked.
  function handleRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || event.defaultPrevented) return
    if (!event.currentTarget.contains(event.target as Node)) return
    if (menuOpenRef.current || typed || !open) return
    event.preventDefault()
    focusFieldQuietly()
    setExpanded(false)
  }

  function handleMenuOpenChange(next: boolean) {
    menuOpenRef.current = next
    setMenuOpen(next)
    onMenuOpenChange(next)
    if (!next) recheck()
  }

  return (
    <div
      ref={rootRef}
      className="flex flex-col"
      onFocus={(event) => {
        if (quietFocusRef.current) {
          quietFocusRef.current = false
          return
        }
        // Unfolding would make the outcome line inert while it holds focus.
        if (outcomeRef.current?.contains(event.target as Node)) return
        setExpanded(true)
      }}
      onBlur={recheck}
      onKeyDown={handleRootKeyDown}
    >
      <DockBand
        open={bandOpen}
        sending={sending}
        onFolded={handleFolded}
        aria-label="Task options"
      >
        {/* Two rows share one cell, so swapping them never changes height. */}
        <div className="grid">
          <motion.div
            ref={outcomeRef}
            initial={false}
            animate={open ? "off" : "on"}
            variants={reduce ? ROW_STILL : ROW}
            inert={open || outcome === null ? true : undefined}
            className="col-start-1 row-start-1 flex min-w-0 items-center gap-2"
          >
            <CircleCheckIcon aria-hidden="true" className="text-success size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {outcome?.text}
            </span>
            {/* Outline, not ghost: a ghost hover is the band's own muted fill. */}
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                focusFieldQuietly()
                onUndo()
              }}
            >
              Undo
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-xs"
                    aria-label="Dismiss"
                    onClick={() => {
                      focusFieldQuietly()
                      onDismissOutcome()
                    }}
                  />
                }
              >
                <XIcon aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Dismiss</TooltipContent>
            </Tooltip>
          </motion.div>

          <motion.div
            initial={reduce ? false : "off"}
            animate={open ? "on" : "off"}
            variants={reduce ? ROW_STILL : ROW}
            inert={open ? undefined : true}
            className="col-start-1 row-start-1 flex min-w-0 items-center gap-1.5"
          >
            <DropdownMenu onOpenChange={handleMenuOpenChange}>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    // Announces the scope the tasks will run on with the button.
                    aria-describedby={scopeId}
                    className="rounded-full"
                  />
                }
              >
                Tasks
                <ChevronUpIcon data-icon="inline-end" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-72"
              >
                {ASSIST_GROUPS.map((group, index) => (
                  <Fragment key={group}>
                    {index > 0 ? <DropdownMenuSeparator /> : null}
                    {/* Explicit ids: the Radix group has no label link of its own. */}
                    <DropdownMenuGroup aria-labelledby={`${menuId}-${group}`}>
                      <DropdownMenuLabel id={`${menuId}-${group}`}>
                        {group}
                      </DropdownMenuLabel>
                      {ASSIST_ACTIONS.filter(
                        (action) => action.group === group
                      ).map((action) => (
                        <DropdownMenuItem
                          key={action.id}
                          onClick={() =>
                            dispatchAfterFold(() => onRun(action.id))
                          }
                        >
                          {action.icon}
                          <span className="min-w-0 flex-1 truncate">
                            {action.label}
                          </span>
                          {/* The accessory slot recolours on the highlighted row;
                              the row's own tracking replaces its key spacing. */}
                          {readouts[action.id] ? (
                            <DropdownMenuShortcut className="shrink-0 text-xs tracking-[inherit] tabular-nums">
                              {readouts[action.id]}
                            </DropdownMenuShortcut>
                          ) : null}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <span
              aria-hidden="true"
              className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs"
            >
              {scoped ? (
                <HighlighterIcon aria-hidden="true" className="size-4 shrink-0" />
              ) : (
                <FileTextIcon aria-hidden="true" className="size-4 shrink-0" />
              )}
              <span className="truncate">{scopeLabel}</span>
            </span>

            {outcome ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="ms-auto"
                onClick={() => {
                  focusFieldQuietly()
                  onUndo()
                }}
              >
                Undo
              </Button>
            ) : null}
          </motion.div>
        </div>
      </DockBand>

      <FramePanel className="p-0">
        <form onSubmit={submit}>
          <FieldLabel className="sr-only" htmlFor={fieldId}>
            Ask {AGENT.name}
          </FieldLabel>
          {/* Always mounted, so the scope is read while the band is folded. */}
          <span id={scopeId} className="sr-only">
            {scopeLabel}
          </span>
          {/* h-auto: a row group is a fixed input height by default. A press
              reopens the band even when the field already holds focus. */}
          <InputGroup
            // The panel would clip this ring to corner slivers; the dock's
            // light marks focus instead (the field is never invalid).
            className="h-auto border-0 bg-transparent ring-0"
            onPointerDown={() => setExpanded(true)}
          >
            <InputGroupAddon
              align="inline-start"
              onPointerDown={(event) => {
                event.preventDefault()
                fieldRef.current?.focus()
              }}
            >
              <AssistTile />
            </InputGroupAddon>
            <InputGroupTextarea
              id={fieldId}
              ref={fieldRef}
              rows={1}
              aria-describedby={scopeId}
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
              onKeyDown={handleFieldKeyDown}
              placeholder={
                scoped ? "Change the selection" : `Ask ${AGENT.name}`
              }
              className="field-sizing-content max-h-32 min-h-10 py-2 md:py-2.5"
            />
            <InputGroupAddon
              align="inline-end"
              className="h-10 gap-1 self-end py-0 pe-1.5"
            >
              {pending > 0 ? (
                <motion.span
                  layout="position"
                  layoutDependency={open}
                  transition={reduce ? { duration: 0 } : GLIDE}
                  className="flex"
                >
                  <InputGroupButton
                    variant="outline"
                    onClick={onReview}
                    className="rounded-full tabular-nums"
                  >
                    Review {pending}
                  </InputGroupButton>
                </motion.span>
              ) : null}
              {/* Nothing to send until there is intent; it pops in with it. */}
              <AnimatePresence initial={false} mode="popLayout">
                {open ? (
                  <motion.span
                    key="send"
                    className="flex"
                    initial={reduce ? false : { opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={
                      reduce
                        ? { opacity: 0, transition: { duration: 0 } }
                        : {
                            opacity: 0,
                            scale: 0.8,
                            transition: { duration: 0.1 },
                          }
                    }
                    transition={{
                      opacity: { duration: 0.12 },
                      scale: {
                        type: "spring",
                        visualDuration: 0.22,
                        bounce: 0.2,
                      },
                    }}
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <InputGroupButton
                            type="submit"
                            size="icon-sm"
                            variant="default"
                            aria-label={`Send to ${AGENT.name}`}
                            className="rounded-full"
                          />
                        }
                      >
                        <ArrowUpIcon aria-hidden="true" />
                      </TooltipTrigger>
                      <TooltipContent className="flex items-center gap-1.5">
                        Send
                        <Kbd>Enter</Kbd>
                      </TooltipContent>
                    </Tooltip>
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </FramePanel>
    </div>
  )
}