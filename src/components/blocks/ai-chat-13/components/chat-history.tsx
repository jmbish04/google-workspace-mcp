"use client"

import { useRef, useState, type RefCallback } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { threadTitle, type ThreadRecord } from "./data"
import { HistoryIcon, StarIcon, Trash2Icon } from "lucide-react"

const ICON_HISTORY = (
  <HistoryIcon aria-hidden="true" />
)

const ICON_PIN = (
  <StarIcon aria-hidden="true" />
)

/** The pressed twin: same glyph, painted in. Sets that ship a solid path
    ignore the fill, and the foreground colour carries the state there. */
const ICON_PINNED = (
  <StarIcon className="fill-current" aria-hidden="true" />
)

const ICON_DELETE = (
  <Trash2Icon aria-hidden="true" />
)

/** Earlier holds everything before today, so yesterday lands there rather
    than earning a fifth tab the strip cannot fit. */
const THREAD_TABS = [
  {
    id: "all",
    label: "All",
    emptyTitle: "No Chats Yet",
    emptyLead: "Chats you start show up here.",
  },
  {
    id: "pinned",
    label: "Pinned",
    emptyTitle: "No Pinned Chats",
    emptyLead: "Star a chat to keep it here.",
  },
  {
    id: "today",
    label: "Today",
    emptyTitle: "Nothing Today",
    emptyLead: "Today's chats show up here.",
  },
  {
    id: "earlier",
    label: "Earlier",
    emptyTitle: "Nothing Earlier",
    emptyLead: "Older chats show up here.",
  },
]

const DAYS = [
  ["Today", "today"],
  ["Yesterday", "yesterday"],
  ["Earlier", "earlier"],
] as const

/** The All tab's sections: a pinned chat lifts out of its day there. */
function sectionsFor(threads: ThreadRecord[]) {
  return [
    { label: "Pinned", threads: threads.filter((thread) => thread.pinned) },
    ...DAYS.map(([label, recency]) => ({
      label,
      threads: threads.filter(
        (thread) => !thread.pinned && thread.recency === recency
      ),
    })),
  ].filter((section) => section.threads.length > 0)
}

/** The rows a tab shows, in the order they read. */
function threadsForTab(tab: string, threads: ThreadRecord[]) {
  if (tab === "all")
    return sectionsFor(threads).flatMap((section) => section.threads)
  if (tab === "pinned") return threads.filter((thread) => thread.pinned)
  if (tab === "today")
    return threads.filter((thread) => thread.recency === "today")
  return threads.filter((thread) => thread.recency !== "today")
}

function HistoryRow({
  thread,
  active,
  replying,
  rowRef,
  pinRef,
  onSelect,
  onTogglePinned,
  onDelete,
}: {
  thread: ThreadRecord
  active: boolean
  /** True while this chat's reply is still on its way. */
  replying: boolean
  rowRef: RefCallback<HTMLButtonElement>
  pinRef: (node: HTMLButtonElement | null) => void
  onSelect: (id: string) => void
  onTogglePinned: (thread: ThreadRecord) => void
  onDelete: (thread: ThreadRecord, opener: HTMLButtonElement) => void
}) {
  const title = threadTitle(thread)
  const pinned = Boolean(thread.pinned)

  return (
    // The actions sit beside the row, not in it: a button cannot hold another.
    <div className="group/row relative">
      <Button
        ref={rowRef}
        type="button"
        variant={active ? "secondary" : "ghost"}
        size="sm"
        aria-current={active ? "true" : undefined}
        onClick={() => onSelect(thread.id)}
        className="w-full justify-start gap-2 px-2 font-normal pointer-coarse:pe-15"
      >
        <span className="min-w-0 flex-1 truncate text-start">{title}</span>
        {/* With a mouse, the actions cover this column on hover or keyboard focus;
            it fades rather than hides, so the row's name keeps its time. */}
        <span className="text-muted-foreground flex w-16 shrink-0 justify-end text-xs tabular-nums pointer-fine:group-hover/row:opacity-0 pointer-fine:group-has-[:focus-visible]/row:opacity-0">
          {replying ? (
            <>
              <Spinner aria-hidden="true" />
              <span className="sr-only">Replying</span>
            </>
          ) : (
            thread.at
          )}
        </span>
      </Button>

      <div className="absolute end-1 top-1/2 flex -translate-y-1/2 gap-0.5 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-has-[:focus-visible]/row:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                ref={pinRef}
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Pin ${title}`}
                aria-pressed={pinned}
                onClick={() => onTogglePinned(thread)}
                className="text-muted-foreground hover:text-foreground aria-pressed:text-foreground"
              />
            }
          >
            {pinned ? ICON_PINNED : ICON_PIN}
          </TooltipTrigger>
          <TooltipContent>{pinned ? "Unpin" : "Pin"}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete ${title}`}
                onClick={(event) => onDelete(thread, event.currentTarget)}
                className="text-muted-foreground hover:text-foreground"
              />
            }
          >
            {ICON_DELETE}
          </TooltipTrigger>
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

/**
 * History behind the header's clock: every earlier chat by day, to reopen,
 * pin or delete.
 */
export function ChatHistory({
  threads,
  activeId,
  replying,
  onSelectThread,
  onTogglePinned,
  onDeleteThread,
}: {
  threads: ThreadRecord[]
  activeId: string
  /** True while the open chat's reply is on its way. */
  replying: boolean
  onSelectThread: (id: string) => void
  onTogglePinned: (id: string) => void
  onDeleteThread: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState(THREAD_TABS[0].id)
  const [confirmOpen, setConfirmOpen] = useState(false)
  /** Kept after the confirm closes, so its copy holds through the exit. */
  const [doomed, setDoomed] = useState<ThreadRecord | null>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  /** The chat whose Pin button takes focus back once its row re-renders. */
  const refocusPinId = useRef<string | null>(null)
  const tabsListRef = useRef<HTMLDivElement>(null)
  /** Where focus lands once the confirm closes: its opener, or a neighbour
      after a delete. */
  const focusTargetRef = useRef<HTMLElement | null>(null)

  // An empty chat has nothing to go back to, so it stays out of the list.
  const history = threads.filter((thread) => thread.turns.length > 0)

  function registerRow(id: string): RefCallback<HTMLButtonElement> {
    return (node) => {
      if (!node) return
      rowRefs.current.set(id, node)
      // A leaving tab panel unmounts a frame late, so it drops only its own row.
      return () => {
        if (rowRefs.current.get(id) === node) rowRefs.current.delete(id)
      }
    }
  }

  function registerPin(id: string) {
    return (node: HTMLButtonElement | null) => {
      if (!node || refocusPinId.current !== id) return
      refocusPinId.current = null
      node.focus()
    }
  }

  /** The open tab's trigger, where focus goes once its list runs out. */
  function selectedTab() {
    return tabsListRef.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]'
    )
  }

  /** The row after this one in the open tab, else the one before. */
  function neighbourOf(id: string) {
    const visible = threadsForTab(tab, history)
    const index = visible.findIndex((thread) => thread.id === id)
    const neighbour = visible[index + 1] ?? visible[index - 1]
    return neighbour ? rowRefs.current.get(neighbour.id) : undefined
  }

  function togglePinned(thread: ThreadRecord) {
    // Unpinned on the Pinned tab, the row leaves the list; anywhere else it
    // stays or moves groups, and its Pin button keeps focus there.
    if (tab === "pinned" && thread.pinned)
      (neighbourOf(thread.id) ?? selectedTab())?.focus()
    else refocusPinId.current = thread.id
    onTogglePinned(thread.id)
  }

  function requestDelete(thread: ThreadRecord, opener: HTMLButtonElement) {
    focusTargetRef.current = opener
    setDoomed(thread)
    setConfirmOpen(true)
  }

  function confirmDelete() {
    if (!doomed) return
    // The deleted row takes its buttons with it, so focus moves to a neighbour,
    // or to the open tab once the list is empty.
    focusTargetRef.current = neighbourOf(doomed.id) ?? selectedTab() ?? null
    onDeleteThread(doomed.id)
    setConfirmOpen(false)
  }

  function renderRow(thread: ThreadRecord) {
    return (
      <HistoryRow
        key={thread.id}
        thread={thread}
        active={thread.id === activeId}
        replying={replying && thread.id === activeId}
        rowRef={registerRow(thread.id)}
        pinRef={registerPin(thread.id)}
        onSelect={(id) => {
          setOpen(false)
          onSelectThread(id)
        }}
        onTogglePinned={togglePinned}
        onDelete={requestDelete}
      />
    )
  }

  return (
    // A tablist is invalid inside role="menu", so the surface is a popover
    // and every row is a real button rather than a menu item.
    <Popover open={open} onOpenChange={setOpen}>
      {/* The tooltip wraps a span, so each trigger keeps its own element and handlers. */}
      <Tooltip>
        <TooltipTrigger render={<span className="flex" />}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Chat history"
                className="text-muted-foreground hover:text-foreground"
              />
            }
          >
            {ICON_HISTORY}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>History</TooltipContent>
      </Tooltip>
      <PopoverContent
        aria-label="Chat history"
        align="end"
        className="flex max-h-96 w-84 max-w-(--available-width) flex-col p-0"
      >
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(String(value))}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          {/* The strip never scrolls: the list below owns the whole scroll,
              so no row can pass under it. */}
          <div className="flex h-11 shrink-0 items-center border-b px-2">
            {/* Zero padding plus a full-height trigger seats the line underline
                on the strip's own border instead of floating above it. */}
            <TabsList
              ref={tabsListRef}
              variant="line"
              className="h-full gap-0 p-0"
            >
              {THREAD_TABS.map((item) => (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  className="h-full! flex-none px-2 after:-bottom-px!"
                >
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {THREAD_TABS.map((item) => {
            const rows = threadsForTab(item.id, history)
            // The All tab heads each day with a label; the other tabs are one run.
            const groups =
              item.id === "all"
                ? sectionsFor(history)
                : [{ label: null, threads: rows }]
            return (
              // A leaving panel is hidden at once, so a switch never stacks two lists.
              <TabsContent
                key={item.id}
                value={item.id}
                className="scrollbar min-h-0 flex-1 overflow-y-auto data-ending-style:hidden"
              >
                {rows.length === 0 ? (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>{item.emptyTitle}</EmptyTitle>
                      <EmptyDescription>{item.emptyLead}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  // Each group carries the rows' inset, the same px as the tab strip.
                  groups.map((group) => (
                    <div
                      key={group.label ?? item.id}
                      className="flex flex-col gap-1 px-2 py-1.5"
                    >
                      {group.label ? (
                        <span className="text-muted-foreground px-2 text-xs">
                          {group.label}
                        </span>
                      ) : null}
                      {group.threads.map(renderRow)}
                    </div>
                  ))
                )}
              </TabsContent>
            )
          })}
        </Tabs>

        {/* Inside the popup, so the popover stays open behind the confirm and
            the next delete is one click away. */}
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent
            size="sm"
            finalFocus={() => focusTargetRef.current ?? true}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Chat?</AlertDialogTitle>
              <AlertDialogDescription>
                <span className="text-foreground font-medium">
                  {doomed ? threadTitle(doomed) : null}
                </span>{" "}
                and its replies leave your history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={confirmDelete}>
                Delete Chat
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </PopoverContent>
    </Popover>
  )
}