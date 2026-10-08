import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react"
import { cn } from "cn"

import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
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
import {
  CalloutPart,
  CodePart,
  CopyButton,
  DraftPart,
  FiguresPart,
  InlineText,
  ITEM_ENTRANCE,
  TablePart,
} from "./answer-parts"
import { ContextChips } from "./context-chips"
import { answerText, type AnswerBody, type TurnRecord, type Vote } from "./data"
import { answerCost, sliceAnswer, useRevealBudget } from "./reveal"
import { SCROLL_REGION, useScrollEdges } from "./scroll-region"
import { ThumbsUpIcon, ThumbsDownIcon, CornerDownRightIcon } from "lucide-react"

/** The row keeps its space at rest, so nothing shifts when it fades in. */
const TURN_ACTIONS =
  "pointer-events-none flex items-center gap-0.5 opacity-0 transition-opacity group-hover/turn:pointer-events-auto group-hover/turn:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-100"

/** The gap between follow ups landing, so the thread grows a row at a time. */
const FOLLOW_UP_STAGGER_MS = 60

/** How close to the end still counts as reading the newest turn. */
const FOLLOW_SLACK_PX = 24

/** Keys that read back up the thread, so following stops at once. */
const READ_BACK_KEYS = new Set(["ArrowUp", "PageUp", "Home"])

const ICON_UP = (
  <ThumbsUpIcon aria-hidden="true" />
)

const ICON_DOWN = (
  <ThumbsDownIcon aria-hidden="true" />
)

/** What the row says once the reader has rated the answer. */
const VOTE_NOTE: Record<Vote, string> = {
  up: "Glad that helped.",
  down: "Thanks, noted.",
}

const ICON_FOLLOW = (
  <CornerDownRightIcon className="mt-px shrink-0 opacity-50" aria-hidden="true" />
)

const PROSE = "text-sm leading-relaxed"

/** The assistant's answer, part by part in reading order: the lead, its numbers,
    a table, then points, steps, a snippet, a draft, a callout and a caveat. */
function AnswerTurn({
  turn,
  arriving,
  live,
  newest,
  onSend,
  onVote,
}: {
  turn: { id: string; vote?: Vote } & AnswerBody
  arriving: boolean
  /** Arrived while the thread was on screen, so its follow ups land one by one. */
  live: boolean
  /** The thread's last turn: its actions stay in view and its follow ups show. */
  newest: boolean
  onSend: (prompt: string) => void
  onVote: (id: string, vote: Vote | null) => void
}) {
  const budget = useRevealBudget(answerCost(turn), arriving)
  const { view, codeStreaming, tableStreaming } = sliceAnswer(turn, budget)
  const followUps = turn.followUps ?? []
  const [landed, setLanded] = useState(live ? 0 : followUps.length)

  // One follow up per beat once the answer settles, so the thread never jumps a
  // block at once; under reduced motion they land together.
  useEffect(() => {
    // Frozen demo guard: ?demo=frozen pins the demo, so no timer starts.
    if (document.documentElement.dataset.demo === "frozen") return
    if (arriving || !newest || landed >= followUps.length) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const timer = window.setTimeout(
      () => setLanded(reduce ? followUps.length : landed + 1),
      landed === 0 ? 0 : FOLLOW_UP_STAGGER_MS
    )
    return () => window.clearTimeout(timer)
  }, [arriving, newest, landed, followUps.length])
  /** Parts fade in only as they land in a typing answer, never on a reopen. */
  const entering = arriving ? ITEM_ENTRANCE : undefined

  return (
    <div className="group/turn flex flex-col gap-2">
      {/* Full width from the first word, so a table or snippet never sizes
          the bubble and the first line never widens it while it types. */}
      <Bubble variant="outline" className="w-full max-w-full">
        <BubbleContent className="flex w-full flex-col gap-3">
          <p className={PROSE}>
            <InlineText text={view.lead} />
          </p>

          {view.figures ? (
            <FiguresPart figures={view.figures} entering={entering} />
          ) : null}

          {turn.table && view.table ? (
            <TablePart
              table={turn.table}
              rowCount={view.table.rows.length}
              streaming={tableStreaming}
              entering={entering}
            />
          ) : null}

          {view.points ? (
            <ul className="marker:text-muted-foreground flex list-disc flex-col gap-2 ps-4">
              {view.points.map((point, index) => (
                <li key={index} className={PROSE}>
                  <InlineText text={point} />
                </li>
              ))}
            </ul>
          ) : null}

          {view.steps ? (
            <ol className="flex flex-col gap-2">
              {view.steps.map((step, index) => (
                <li key={index} className={cn("flex gap-2.5", PROSE)}>
                  {/* The list already carries the order for a screen reader. */}
                  <span
                    aria-hidden="true"
                    className="text-muted-foreground w-3 shrink-0 tabular-nums"
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <InlineText text={step} />
                  </span>
                </li>
              ))}
            </ol>
          ) : null}

          {view.code ? (
            <CodePart
              {...view.code}
              streaming={codeStreaming}
              entering={entering}
            />
          ) : null}

          {turn.draft && view.draft ? (
            <DraftPart
              title={view.draft.title}
              text={view.draft.text}
              fullText={turn.draft.text}
              entering={entering}
            />
          ) : null}

          {view.callout ? (
            <CalloutPart {...view.callout} entering={entering} />
          ) : null}

          {view.note ? (
            <p className={cn("text-muted-foreground", PROSE)}>
              <InlineText text={view.note} />
            </p>
          ) : null}
        </BubbleContent>
      </Bubble>

      {/* Held invisible while the answer types, so settling adds no height and the
          row fades in where its space already was. */}
      <div
        inert={arriving}
        className={cn(
          TURN_ACTIONS,
          arriving ? "invisible" : newest && "pointer-events-auto opacity-100"
        )}
      >
        <CopyButton
          text={answerText(turn)}
          label="Copy answer"
          tooltip="Copy"
          status="Answer copied"
        />

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Helpful"
                aria-pressed={turn.vote === "up"}
                onClick={() =>
                  onVote(turn.id, turn.vote === "up" ? null : "up")
                }
                className="text-muted-foreground hover:text-foreground aria-pressed:text-success"
              />
            }
          >
            {ICON_UP}
          </TooltipTrigger>
          <TooltipContent>Helpful</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Not helpful"
                aria-pressed={turn.vote === "down"}
                onClick={() =>
                  onVote(turn.id, turn.vote === "down" ? null : "down")
                }
                className="text-muted-foreground hover:text-foreground aria-pressed:text-foreground"
              />
            }
          >
            {ICON_DOWN}
          </TooltipTrigger>
          <TooltipContent>Not helpful</TooltipContent>
        </Tooltip>
        <span role="status" className="text-muted-foreground ps-1.5 text-xs">
          {turn.vote ? VOTE_NOTE[turn.vote] : ""}
        </span>
      </div>

      {/* Only the newest answer offers a next question; an older one would
          answer a turn the thread has moved past. */}
      {newest && !arriving && landed > 0 ? (
        <div className="flex flex-col gap-1">
          {followUps.slice(0, landed).map((prompt) => (
            <Button
              key={prompt}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onSend(prompt)}
              className={cn(
                "text-muted-foreground hover:text-foreground h-auto w-fit max-w-full items-start justify-start gap-2 px-2 py-1 text-xs font-normal whitespace-normal",
                live && ITEM_ENTRANCE
              )}
            >
              {ICON_FOLLOW}
              <span className="min-w-0 text-start">{prompt}</span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The conversation, in a native scroller that follows the newest line while the
 * reader sits at the end, with a thinking marker last while a reply is on its way.
 */
export const ChatThread = memo(function ChatThread({
  turns,
  arrivingId,
  thinking,
  ready,
  followingRef,
  onSend,
  onVote,
}: {
  turns: TurnRecord[]
  arrivingId: string | null
  /** The marker's line while a reply is being prepared, or null. */
  thinking: string | null
  /** True once the newest reply has finished arriving. */
  ready: boolean
  /** True while the reader sits at the end, so growth keeps the tail in view;
      the window's fold reads it too. */
  followingRef: RefObject<boolean>
  onSend: (prompt: string) => void
  onVote: (id: string, vote: Vote | null) => void
}) {
  const busy = thinking !== null || arrivingId !== null
  const scrollerRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const threadKey = turns[0]?.id
  const lastAskedId = turns.filter((turn) => turn.kind === "asked").at(-1)?.id
  const newestId = turns.at(-1)?.id
  // The turns a chat opens with arrive whole; only the ones added while it is on
  // screen fade in, so a reopen or a switch never replays them.
  const [opened, setOpened] = useState(() => ({
    key: threadKey,
    ids: new Set(turns.map((turn) => turn.id)),
  }))
  if (opened.key !== threadKey)
    setOpened({ key: threadKey, ids: new Set(turns.map((turn) => turn.id)) })

  // The log growing or the thread shrinking (a taller draft, a smaller window)
  // keeps the newest line in view, but only while the reader stays at the end.
  useEffect(() => {
    const scroller = scrollerRef.current
    const log = logRef.current
    if (!scroller || !log) return
    let lastTop = scroller.scrollTop
    // At the very end it always follows; any move up is reading back, and a
    // move down into the slack picks the tail up again.
    const onScroll = () => {
      const distance =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      if (distance <= 1) followingRef.current = true
      else if (scroller.scrollTop < lastTop) followingRef.current = false
      else if (distance <= FOLLOW_SLACK_PX) followingRef.current = true
      lastTop = scroller.scrollTop
    }
    const stopFollowing = () => {
      followingRef.current = false
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stopFollowing()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (READ_BACK_KEYS.has(event.key)) stopFollowing()
    }
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scroller.scrollTop = scroller.scrollHeight
    })
    scroller.addEventListener("scroll", onScroll, { passive: true })
    scroller.addEventListener("wheel", onWheel, { passive: true })
    scroller.addEventListener("touchmove", stopFollowing, { passive: true })
    scroller.addEventListener("keydown", onKeyDown)
    observer.observe(log)
    observer.observe(scroller)
    return () => {
      observer.disconnect()
      scroller.removeEventListener("scroll", onScroll)
      scroller.removeEventListener("wheel", onWheel)
      scroller.removeEventListener("touchmove", stopFollowing)
      scroller.removeEventListener("keydown", onKeyDown)
    }
  }, [followingRef])

  // A chat opens on its newest turn, and a question just sent brings the reader
  // back to the end even if they had scrolled up; before paint, so it never jumps.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    followingRef.current = true
    scroller.scrollTop = scroller.scrollHeight
  }, [followingRef, threadKey, lastAskedId])

  // Measured after the follow snap above, so growth never reads a stale edge.
  useScrollEdges(scrollerRef, logRef)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        role="region"
        aria-label="Conversation"
        tabIndex={0}
        data-fold="thread"
        className={`${SCROLL_REGION} peer outline-none`}
      >
        {/* pt-18 starts the turns below the floating header and its fade. */}
        <div
          ref={logRef}
          role="log"
          aria-relevant="additions"
          aria-busy={busy}
          className="flex flex-col gap-4 px-4 pt-18 pb-2"
        >
          {turns.map((turn) => (
            <div
              key={turn.id}
              // An answer types itself in, so only a question fades.
              className={
                turn.kind === "asked" && !opened.ids.has(turn.id)
                  ? ITEM_ENTRANCE
                  : undefined
              }
            >
              {turn.kind === "asked" ? (
                <div className="flex flex-col items-end gap-1.5">
                  <Bubble variant="default" align="end">
                    <BubbleContent className="text-sm leading-relaxed">
                      {turn.text}
                    </BubbleContent>
                  </Bubble>
                  <ContextChips ids={turn.sources} className="justify-end" />
                  {turn.stopped ? (
                    <span className="text-muted-foreground text-xs">
                      Reply stopped
                    </span>
                  ) : null}
                </div>
              ) : (
                <AnswerTurn
                  turn={turn}
                  arriving={arrivingId === turn.id}
                  live={!opened.ids.has(turn.id)}
                  newest={turn.id === newestId}
                  onSend={onSend}
                  onVote={onVote}
                />
              )}
            </div>
          ))}

          {thinking ? (
            // Pinned to body small: each style's own marker type would shrink or uppercase it.
            <Marker
              className={cn(
                ITEM_ENTRANCE,
                "text-sm tracking-normal normal-case"
              )}
            >
              <MarkerIcon>
                <Spinner />
              </MarkerIcon>
              {/* The shimmer utility stills itself under reduced motion. */}
              <MarkerContent className="shimmer">{thinking}</MarkerContent>
            </Marker>
          ) : null}
        </div>
      </div>
      {/* The scroller runs under the header and its edge mask would clip a
          ring, so focus is drawn on a still layer above both. */}
      <span
        aria-hidden="true"
        className="ring-ring/50 pointer-events-none absolute inset-x-0 top-12 bottom-0 z-30 hidden ring-[3px] ring-inset peer-focus-visible:block"
      />

      {/* aria-busy silences the log, so the in flight step and the finished
          reply are announced from outside it rather than not at all. */}
      <p role="status" aria-live="polite" className="sr-only">
        {thinking ?? (ready ? "Reply ready" : "")}
      </p>
    </div>
  )
})