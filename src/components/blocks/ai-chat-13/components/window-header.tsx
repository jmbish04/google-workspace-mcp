import type { ReactNode, Ref } from "react"
import { Badge } from "@/components/reui/badge"

import { Button } from "@/components/ui/button"
import { CardDescription, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ChatHistory } from "./chat-history"
import { ASSISTANT_NAME, PAGE_NAME, type ThreadRecord } from "./data"
import { Maximize2Icon, Minimize2Icon, MinusIcon, ChevronUpIcon, SquarePenIcon, XIcon } from "lucide-react"

const MUTED_ICON_BUTTON = "text-muted-foreground hover:text-foreground"
const TITLE = "truncate text-sm font-medium tracking-normal normal-case"

// Both glyphs stay mounted and the pressed state picks one, so the swap never
// waits on a fresh icon and the button never shows empty.
const ICON_EXPAND = (
  <Maximize2Icon className="group-aria-pressed/expand:hidden" aria-hidden="true" />
)

const ICON_COLLAPSE = (
  <Minimize2Icon className="hidden group-aria-pressed/expand:block" aria-hidden="true" />
)

const ICON_MINIMIZE = (
  <MinusIcon aria-hidden="true" />
)

const ICON_RESTORE = (
  <ChevronUpIcon aria-hidden="true" />
)

/** One ghost icon button with its tooltip, the header's only control shape. */
function HeaderButton({
  label,
  tooltip = label,
  onClick,
  disabled,
  pressed,
  className,
  buttonRef,
  children,
}: {
  label: string
  tooltip?: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  className?: string
  buttonRef?: Ref<HTMLButtonElement>
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={buttonRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={className ?? MUTED_ICON_BUTTON}
          />
        }
      >
        {children}
      </TooltipTrigger>
      {/* Gone the moment it closes: the header may already be moving. */}
      <TooltipContent className="data-closed:hidden">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The chat's title bar: who is answering, then start over, go back to an
 * earlier chat, resize, minimize to the pinned bar, or end the chat.
 */
export function WindowHeader({
  surface,
  threads,
  activeId,
  canStartNew,
  expanded,
  streaming,
  replying,
  unread,
  onNewChat,
  onSelectThread,
  onTogglePinned,
  onDeleteThread,
  onExpandedChange,
  onMinimizedChange,
  onEndChat,
  minimizeButtonRef,
  titleId,
  descriptionId,
}: {
  /** The chat window, or the bar the chat folds to when minimized. */
  surface: "window" | "bar"
  threads: ThreadRecord[]
  activeId: string
  /** False while the open chat is still empty, so New chat has nothing to do. */
  canStartNew: boolean
  expanded: boolean
  /** True while the open chat's reply is on its way, marked on its History row. */
  streaming: boolean
  /** Shown on the bar only, which carries the reply's progress. */
  replying: boolean
  unread: boolean
  onNewChat: () => void
  onSelectThread: (id: string) => void
  onTogglePinned: (id: string) => void
  onDeleteThread: (id: string) => void
  onExpandedChange: (expanded: boolean) => void
  onMinimizedChange: (minimized: boolean) => void
  onEndChat: () => void
  /** Lets the bar take focus on the button that brings the chat back. */
  minimizeButtonRef?: Ref<HTMLButtonElement>
  /** The window's dialog is named and described by these; the bar has neither. */
  titleId?: string
  descriptionId?: string
}) {
  const bar = surface === "bar"

  return (
    // Floats over the thread so turns pass under its blur and fade. The window's own top
    // radius, and no blur on the bar, keep Chrome from painting that blur past the corners.
    <div className="bg-popover/70 supports-backdrop-filter:bg-popover/60 after:from-popover absolute inset-x-0 top-0 z-20 rounded-t-xl backdrop-blur-md after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-linear-to-b after:to-transparent in-data-[size=minimized]:backdrop-filter-none">
      {/* While the window folds, its clipped top edge loses the ring; this hairline
          stands in, and window-motion.ts moves the header it sits on. */}
      <span
        aria-hidden="true"
        data-fold="edge"
        className="border-foreground/10 pointer-events-none absolute inset-0 hidden rounded-t-xl border-t in-data-folding:block"
      />
      {/* px-3 lets the icon buttons' own padding carry the end edge; ps-1 puts
          the title on the same 16px line as the thread and composer below it. */}
      <div className="flex min-h-12 items-center gap-1 px-3">
        <div className="flex min-w-0 items-center gap-2 ps-1">
          {/* Pinned to one size and case: each style's own title grows, shrinks or tracks out.
              In the window it heads the dialog; the bar is a region with its own label. */}
          <CardTitle
            id={titleId}
            role={bar ? undefined : "heading"}
            aria-level={bar ? undefined : 2}
            className={TITLE}
          >
            {ASSISTANT_NAME}
          </CardTitle>
          <Badge variant="outline">Beta</Badge>
          {bar ? (
            <span
              role="status"
              data-fold="status"
              className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs"
            >
              {replying ? (
                <>
                  <Spinner aria-hidden="true" />
                  <span className="truncate">Replying</span>
                </>
              ) : unread ? (
                <Badge variant="primary-light">New Reply</Badge>
              ) : null}
            </span>
          ) : (
            <CardDescription id={descriptionId} className="sr-only">
              Answers from {PAGE_NAME} and what you attach.
            </CardDescription>
          )}
        </div>

        <div className="ms-auto flex shrink-0 items-center gap-0.5">
          {bar ? null : (
            // The window's own controls: a fold fades them before it lands on the bar.
            <div data-fold="controls" className="flex items-center gap-0.5">
              <HeaderButton
                label="New chat"
                onClick={onNewChat}
                disabled={!canStartNew}
              >
                <SquarePenIcon aria-hidden="true" />
              </HeaderButton>

              <ChatHistory
                threads={threads}
                activeId={activeId}
                replying={streaming}
                onSelectThread={onSelectThread}
                onTogglePinned={onTogglePinned}
                onDeleteThread={onDeleteThread}
              />

              {/* Chat actions on the left of the rule, panel controls on the right. */}
              <Separator orientation="vertical" className="my-auto h-4" />
            </div>
          )}

          {/* Hidden where the window is already full height: on a phone, and on a screen
              under 42rem tall (40rem plus insets). From the bar it restores full height. */}
          <HeaderButton
            label="Expand chat"
            tooltip={expanded && !bar ? "Collapse" : "Expand"}
            pressed={expanded && !bar}
            onClick={() => onExpandedChange(bar || !expanded)}
            className={`${MUTED_ICON_BUTTON} group/expand max-sm:hidden [@media(max-height:42rem)]:hidden`}
          >
            {ICON_EXPAND}
            {ICON_COLLAPSE}
          </HeaderButton>

          <HeaderButton
            label={bar ? "Restore chat" : "Minimize chat"}
            tooltip={bar ? "Restore" : "Minimize"}
            onClick={() => onMinimizedChange(!bar)}
            buttonRef={minimizeButtonRef}
          >
            {bar ? ICON_RESTORE : ICON_MINIMIZE}
          </HeaderButton>

          <HeaderButton label="End chat" onClick={onEndChat}>
            <XIcon aria-hidden="true" />
          </HeaderButton>
        </div>
      </div>
    </div>
  )
}