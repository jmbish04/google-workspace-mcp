import { useEffect, useState } from "react"

import type { AnswerBody } from "./data"

/** One reveal tick. Every tick grows the transcript, which costs a resize
    observation and an autoscroll, so a slower clock carries more text. */
const TICK_MS = 50
/** Reading pace, and the floor and cap on how long a reply may take. */
const CHARS_PER_TICK = 12
const MIN_TICKS = 18
const MAX_TICKS = 80
/** A table row, a figure or a callout lands whole, one beat of prose each. */
const BLOCK_COST = 40
/** The pause before the next part starts, in characters of the same pace. */
const GAP_COST = 24
/** Code lands a line at a time, faster than prose types. */
const CODE_SPEEDUP = 2

/** One character rate for the whole reply, so a long answer takes longer than
    a short one without ever dragging. */
function revealRate(total: number) {
  const ticks = Math.min(
    MAX_TICKS,
    Math.max(MIN_TICKS, Math.round(total / CHARS_PER_TICK))
  )
  return Math.max(2, Math.ceil(total / ticks))
}

/** True when the reader has asked for no motion, so the reply lands whole. */
function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Closes a run the slice cut open at `marker`, so it types in its final style;
    an opener with nothing after it yet is dropped. */
function closeRun(text: string, marker: string) {
  if ((text.split(marker).length - 1) % 2 === 0) return text
  const open = text.lastIndexOf(marker)
  return open + marker.length < text.length
    ? text + marker
    : text.slice(0, open)
}

/** A half typed sentence never shows its own markers: open code and bold runs
    close early, and a cut between the two stars of a marker drops the first. */
function closeMarkup(text: string) {
  const whole = /(^|[^*])\*$/.test(text) ? text.slice(0, -1) : text
  return closeRun(closeRun(whole, "`"), "**")
}

/** Cuts the answer at the budget in reading order: prose types, blocks land
    whole, code a line at a time. An infinite budget gives the whole answer. */
export function sliceAnswer(body: AnswerBody, budget: number) {
  let spent = 0
  /** How far into a part of this cost the budget reaches; 0 before it starts. */
  const reach = (cost: number) => {
    const reached = Math.max(0, Math.min(cost, budget - spent))
    spent += cost + GAP_COST
    return reached
  }
  const typed = (text: string) => {
    const reached = reach(text.length)
    if (reached === 0) return undefined
    if (reached >= text.length) return text
    // A cut right after an opener leaves nothing yet, so no empty bullet shows.
    return closeMarkup(text.slice(0, reached)) || undefined
  }
  const typedList = (items?: string[]) => {
    const shown = (items ?? []).map(typed).filter((item) => item !== undefined)
    return shown.length ? shown : undefined
  }
  const landed = <T>(items?: T[]) => {
    if (!items?.length) return undefined
    const count = Math.ceil(reach(items.length * BLOCK_COST) / BLOCK_COST)
    return count ? items.slice(0, count) : undefined
  }

  const lead = typed(body.lead) ?? ""
  const figures = landed(body.figures)
  const rows = landed(body.table?.rows)
  const table = body.table && rows ? { ...body.table, rows } : undefined
  const points = typedList(body.points)
  const steps = typedList(body.steps)

  const codeCost = Math.ceil((body.code?.code.length ?? 0) / CODE_SPEEDUP)
  const codeReached = body.code ? reach(codeCost) : 0
  const codeLines = body.code?.code.split("\n") ?? []
  const code =
    body.code && codeReached > 0
      ? {
          ...body.code,
          code: codeLines
            .slice(0, Math.ceil((codeReached / codeCost) * codeLines.length))
            .join("\n"),
        }
      : undefined

  const draftText = body.draft ? typed(body.draft.text) : undefined
  const draft =
    body.draft && draftText ? { ...body.draft, text: draftText } : undefined
  const callout = body.callout && reach(BLOCK_COST) ? body.callout : undefined
  const note = body.note ? typed(body.note) : undefined

  return {
    view: {
      ...body,
      lead,
      figures,
      table,
      points,
      steps,
      code,
      draft,
      callout,
      note,
    } satisfies AnswerBody,
    /** Held back while its lines are still landing. */
    codeStreaming: codeReached < codeCost,
    /** A total is only true once every row has landed. */
    tableStreaming: (rows?.length ?? 0) < (body.table?.rows.length ?? 0),
    /** What the whole answer costs, without the pause after its last part. */
    cost: spent - GAP_COST,
  }
}

/** What the whole answer costs to reveal, in characters of its own pace. */
export function answerCost(body: AnswerBody) {
  return sliceAnswer(body, Infinity).cost
}

/** How long the reveal will take, so a settle timer can wait it out instead
    of guessing at a fixed number. */
export function revealDurationMs(total: number) {
  if (prefersReducedMotion()) return TICK_MS
  return Math.ceil(total / revealRate(total)) * TICK_MS
}

/** How much of the reply has arrived: it grows while active, and a settled
    reply reads whole. */
export function useRevealBudget(total: number, active: boolean) {
  const rate = revealRate(total)
  // Starts on the first chunk, so a reply never opens with an empty line.
  const [revealed, setRevealed] = useState(rate)

  useEffect(() => {
    // Frozen demo guard: ?demo=frozen pins the demo, so no timer starts.
    if (document.documentElement.dataset.demo === "frozen") return
    if (!active) return
    // Reduced motion lands the whole reply on the first tick.
    const step = prefersReducedMotion() ? total : rate
    const timer = window.setInterval(() => {
      setRevealed((current) => Math.min(total, current + step))
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [active, rate, total])

  return active ? revealed : Infinity
}