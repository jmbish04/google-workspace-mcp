import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react"
import {
  animate,
  frame,
  motionValue,
  useReducedMotion,
  type MotionValue,
} from "motion/react"

/** Quick to answer, soft to land: entrances, exits and fades. */
const EASE_OUT = [0.22, 1, 0.36, 1] as const
/** A plain ease out: half the speed of EASE_OUT at the start, so a long fold's first
    frames never leap. */
const EASE_FOLD = [0.5, 1, 0.89, 1] as const

const OPEN = { duration: 0.22, ease: EASE_OUT }
const CLOSE = { duration: 0.18, ease: EASE_OUT }
const FADE_OUT = { duration: 0.1, ease: EASE_OUT }
const FADE_IN = { duration: 0.16, delay: 0.06, ease: EASE_OUT }
const SWAP_IN = { duration: 0.16, ease: EASE_OUT }

/** A longer fold takes a little longer, so no frame steps much past 45px: 200ms for
    Expand, about 230ms for Minimize, 300ms at most for a phone-tall window. */
function foldFor(travel: number) {
  return {
    duration: Math.min(0.3, Math.max(0.2, travel / 2600)),
    ease: EASE_FOLD,
  }
}

/** The window (or bar) fades over the middle of the swap... */
function partnerOpacity(swap: number) {
  return Math.min(1, Math.max(0, (swap - 0.15) / 0.7))
}

/** ...and the launcher over its first third, so the two never stack and the
    corner is never empty. */
function launcherOpacity(swap: number) {
  return Math.min(1, Math.max(0, 1 - swap / 0.3))
}

type Surface = "window" | "bar" | "launcher"

type Transition = {
  duration: number
  ease: typeof EASE_OUT | typeof EASE_FOLD
  delay?: number
}

/** A value, where it heads and how. */
type Step = [MotionValue<number>, number, Transition]

function createValues() {
  return {
    /** 1 shows the window or bar (the partner), 0 the launcher. */
    swap: motionValue(1),
    /** Everything under the window's header, faded by a fold; 1 is at rest. */
    body: motionValue(1),
    /** The header's window-only controls, gone before a fold lands on the bar. */
    controls: motionValue(1),
    /** The thread or starters, faded in when another chat takes their place. */
    content: motionValue(1),
    /** The bar's Replying or New Reply note. */
    status: motionValue(1),
    /** How far the window's top edge has folded down, in px; 0 is at rest. */
    edge: motionValue(0),
    /** How far the content rides down with that edge until the layout catches up. */
    shift: motionValue(0),
  }
}

function part(root: HTMLElement, name: string) {
  return root.querySelector<HTMLElement>(`[data-fold="${name}"]`)
}

/** Writes only what changed; an empty value removes the property. */
function setStyle(
  element: HTMLElement | null,
  property: string,
  value: string
) {
  if (!element || element.style.getPropertyValue(property) === value) return
  if (value) element.style.setProperty(property, value)
  else element.style.removeProperty(property)
}

/**
 * Runs `start` on the frame after the next one: the commit's first frame paints the
 * start state exactly, so a long commit never eats the opening frames.
 */
function afterFirstPaint(start: () => void) {
  frame.postRender(() => frame.postRender(start))
}

/** A compositor layer only while something moves. */
function willChange(...moving: (string | false)[]) {
  return moving.filter(Boolean).join(", ")
}

/** Holds a surface shown, or back, against its class while it moves ("" hands it
    back); content-visibility keeps a button's own transition from outliving it. */
function hold(element: HTMLElement, state: "shown" | "hidden" | "") {
  const value = state === "shown" ? "visible" : state
  setStyle(element, "visibility", value)
  setStyle(element, "content-visibility", value)
}

/** The launcher rests display:none under an open chat; this keeps it laid out while
    it gives way. */
function holdLauncher(element: HTMLElement, shown: boolean) {
  setStyle(element, "display", shown ? "inline-flex" : "")
}

export function useWindowMotion({
  open,
  minimized,
  expanded,
  contentKey,
  windowRef,
  barRef,
  launcherRef,
  followingRef,
  onBarShown,
  onClosed,
}: {
  open: boolean
  minimized: boolean
  expanded: boolean
  /** Changes when another chat, or a fresh one, takes the window's content. */
  contentKey: string
  windowRef: RefObject<HTMLDivElement | null>
  barRef: RefObject<HTMLDivElement | null>
  launcherRef: RefObject<HTMLButtonElement | null>
  /** True while the thread keeps its newest line in view. */
  followingRef: RefObject<boolean>
  /** The fold has landed and the bar has taken the corner. */
  onBarShown: () => void
  /** The window or the bar has finished leaving. */
  onClosed: () => void
}) {
  const reduce = useReducedMotion() ?? false
  const surface: Surface = !open ? "launcher" : minimized ? "bar" : "window"
  const [values] = useState(createValues)
  /** Which surface trades places with the launcher, and whether they are mid-swap. */
  const partner = useRef<"window" | "bar">("window")
  const swapping = useRef(false)
  /** Repaints the swap at once, for the moment it starts or settles. */
  const paintSwapRef = useRef(() => {})
  /** The window's corner radius plus its ring, read when a fold starts. */
  const radius = useRef(0)
  /** Bumped by each transition of a group, so one that was replaced never lands. */
  const turns = useRef({ swap: 0, fold: 0 })
  const seen = useRef({ surface, expanded, contentKey })
  const latest = useRef({ reduce, onBarShown, onClosed })

  useLayoutEffect(() => {
    latest.current = { reduce, onBarShown, onClosed }
  })

  // Each value paints its own elements; at rest every inline style is gone.
  useEffect(() => {
    const win = windowRef.current
    const bar = barRef.current
    const launcher = launcherRef.current
    if (!win || !bar || !launcher) return
    const header = part(win, "edge")?.parentElement ?? null
    const controls = part(win, "controls")
    const body = part(win, "body")
    const content = part(win, "content")
    const status = part(bar, "status")

    const paintSwap = () => {
      const swap = values.swap.get()
      const moving = swapping.current
      const away = partner.current === "bar" ? bar : win
      const still = away === bar ? win : bar
      const opacity = partnerOpacity(swap)
      setStyle(away, "opacity", moving ? String(opacity) : "")
      // The window rises from its corner; the bar only sinks a few px.
      setStyle(
        away,
        "transform",
        !moving
          ? ""
          : away === win
            ? `translateY(${(1 - swap) * 8}px) scale(${0.96 + 0.04 * swap})`
            : `translateY(${(1 - swap) * 4}px)`
      )
      setStyle(away, "will-change", willChange(moving && "opacity, transform"))
      for (const property of ["opacity", "transform", "will-change"])
        setStyle(still, property, "")
      const shown = launcherOpacity(swap)
      setStyle(launcher, "opacity", moving ? String(shown) : "")
      setStyle(
        launcher,
        "transform",
        moving ? `scale(${0.9 + 0.1 * shown})` : ""
      )
      setStyle(
        launcher,
        "will-change",
        willChange(moving && "opacity, transform")
      )
    }
    const paintFold = () => {
      const edge = values.edge.get()
      const r = radius.current
      // Outset sides and bottom keep the ring and shadow; the cut rounds like a corner.
      setStyle(
        win,
        "clip-path",
        edge > 0
          ? `inset(${edge}px -1px -16px -1px round ${r}px ${r}px 0px 0px)`
          : ""
      )
      setStyle(header, "transform", edge > 0 ? `translateY(${edge}px)` : "")
      setStyle(header, "will-change", willChange(edge > 0 && "transform"))
    }
    const paintContent = () => {
      const shown = values.content.get()
      const shift = values.shift.get()
      setStyle(content, "opacity", shown < 1 ? String(shown) : "")
      setStyle(content, "transform", shift > 0 ? `translateY(${shift}px)` : "")
      // Riding down, the content's foot would cross the composer; the clip holds it.
      setStyle(
        content,
        "clip-path",
        shift > 0 ? `inset(0px 0px ${shift}px 0px)` : ""
      )
      setStyle(
        content,
        "will-change",
        willChange(shift > 0 && "transform", shown < 1 && "opacity")
      )
    }
    const fade = (element: HTMLElement | null, value: MotionValue<number>) => {
      const shown = value.get()
      setStyle(element, "opacity", shown < 1 ? String(shown) : "")
      setStyle(element, "will-change", willChange(shown < 1 && "opacity"))
    }

    paintSwapRef.current = paintSwap
    const stops = [
      values.swap.on("change", paintSwap),
      values.edge.on("change", paintFold),
      values.content.on("change", paintContent),
      values.shift.on("change", paintContent),
      values.body.on("change", () => fade(body, values.body)),
      values.controls.on("change", () => fade(controls, values.controls)),
      values.status.on("change", () => fade(status, values.status)),
    ]
    return () => {
      for (const stop of stops) stop()
    }
  }, [values, windowRef, barRef, launcherRef])

  // Before paint, so the first frame of every transition already shows its start.
  useLayoutEffect(() => {
    const was = seen.current
    seen.current = { surface, expanded, contentKey }
    const win = windowRef.current
    const bar = barRef.current
    const launcher = launcherRef.current
    if (!win || !bar || !launcher) return
    const { reduce, onBarShown, onClosed } = latest.current
    const thread = part(win, "thread")
    const scroller = thread ?? part(win, "starters")

    /**
     * Freezes each value now, so a long commit never lets a motion run on, then
     * heads off after the first paint; `then` lands only if nothing took over.
     */
    function play(group: "swap" | "fold", steps: Step[], then?: () => void) {
      const id = ++turns.current[group]
      for (const [value] of steps) value.stop()
      afterFirstPaint(() => {
        if (id !== turns.current[group]) return
        const running = steps.map(([value, target, transition]) =>
          animate(value, target, transition)
        )
        void Promise.all(running.map((item) => item.finished)).then(() => {
          if (id === turns.current[group]) then?.()
        })
      })
    }

    /** Clears every fold the window was in, while nobody can see it. */
    function rest(target: HTMLElement) {
      setStyle(target, "height", "")
      target.removeAttribute("data-folding")
      values.edge.jump(0)
      values.shift.jump(0)
      values.body.jump(1)
      values.controls.jump(1)
    }

    /** Starts or settles the window, or bar, trading places with the launcher. */
    function swap(active: boolean) {
      swapping.current = active
      paintSwapRef.current()
    }

    function startFold(target: HTMLElement) {
      const corner = getComputedStyle(target).borderTopLeftRadius
      radius.current = (Number.parseFloat(corner) || 0) + 1
      target.setAttribute("data-folding", "")
    }

    /** The thread snaps to its newest line if the reader was following it. */
    function follow() {
      if (thread && followingRef.current) thread.scrollTop = thread.scrollHeight
    }

    /** The top of the content in view, read after the follow has snapped. */
    function contentTop() {
      follow()
      return scroller?.firstElementChild?.getBoundingClientRect().top ?? 0
    }

    if (was.surface !== surface) {
      if (reduce) {
        // Reduced motion: every surface swaps at once, from its class alone.
        ++turns.current.swap
        ++turns.current.fold
        hold(win, "")
        hold(bar, "")
        holdLauncher(launcher, false)
        values.swap.jump(surface === "launcher" ? 0 : 1)
        swap(false)
        if (surface !== "window") rest(win)
        if (surface === "bar") onBarShown()
        if (surface === "launcher") onClosed()
        return
      }

      if (surface === "launcher") {
        // Close, from the window or the bar: it drops away as the launcher returns.
        const leaving = was.surface === "bar" ? bar : win
        partner.current = leaving === bar ? "bar" : "window"
        hold(win, leaving === win ? "shown" : "")
        hold(bar, leaving === bar ? "shown" : "")
        holdLauncher(launcher, false)
        swap(true)
        // A fold still running ends with the close; its own landing never comes.
        ++turns.current.fold
        play("swap", [[values.swap, 0, CLOSE]], () => {
          hold(leaving, "")
          swap(false)
          rest(win)
          onClosed()
        })
        return
      }

      if (was.surface === "launcher") {
        // Open: the launcher gives way as the window rises from its corner.
        partner.current = "window"
        hold(win, "")
        hold(bar, "")
        holdLauncher(launcher, true)
        if (!values.swap.isAnimating()) values.swap.jump(0)
        swap(true)
        play("swap", [[values.swap, 1, OPEN]], () => {
          holdLauncher(launcher, false)
          swap(false)
        })
        return
      }

      if (surface === "bar") {
        // Minimize: the top edge folds down onto the bar's row while the body fades,
        // then the bar takes the corner in the same frame.
        hold(win, "shown")
        hold(bar, "hidden")
        if (!win.hasAttribute("data-folding")) startFold(win)
        const target = win.offsetHeight - bar.offsetHeight
        const fold = foldFor(target - values.edge.get())
        play(
          "fold",
          [
            [values.edge, target, fold],
            [values.body, 0, FADE_OUT],
            [values.controls, 0, FADE_OUT],
          ],
          () => {
            hold(bar, "")
            hold(win, "")
            rest(win)
            values.status.jump(0)
            animate(values.status, 1, SWAP_IN)
            onBarShown()
          }
        )
        return
      }

      // Restore: the window takes the bar's exact row, then unfolds upward.
      hold(win, "")
      hold(bar, "")
      if (!win.hasAttribute("data-folding")) {
        startFold(win)
        values.edge.jump(win.offsetHeight - bar.offsetHeight)
        values.body.jump(0)
        values.controls.jump(0)
      }
      const fold = foldFor(values.edge.get())
      play(
        "fold",
        [
          [values.edge, 0, fold],
          [values.body, 1, FADE_IN],
          [values.controls, 1, FADE_IN],
        ],
        () => win.removeAttribute("data-folding")
      )
      return
    }

    if (surface !== "window") return

    if (was.expanded !== expanded) {
      if (reduce) return
      if (expanded && win.style.getPropertyValue("height")) {
        // Expand during a collapse: the layout is still the tall one, so unfold.
        setStyle(win, "height", "")
        const fold = foldFor(values.edge.get())
        play(
          "fold",
          [
            [values.edge, 0, fold],
            [values.shift, 0, fold],
          ],
          () => win.removeAttribute("data-folding")
        )
        return
      }
      if (expanded) {
        // Expand: lay the tall window out once, clip it back to the old top, then
        // unfold; the header rides the edge and top-anchored content rides with it.
        setStyle(win, "height", "var(--window-h)")
        const fromHeight = win.offsetHeight
        const fromTop = contentTop()
        setStyle(win, "height", "")
        const toHeight = win.offsetHeight
        const toTop = contentTop()
        if (toHeight - fromHeight < 1) return
        startFold(win)
        values.edge.jump(values.edge.get() + toHeight - fromHeight)
        values.shift.jump(values.shift.get() + Math.max(0, fromTop - toTop))
        const fold = foldFor(values.edge.get())
        play(
          "fold",
          [
            [values.edge, 0, fold],
            [values.shift, 0, fold],
          ],
          () => win.removeAttribute("data-folding")
        )
        return
      }
      // Collapse: measure where it lands (shrinking only adds scroll room, so nothing
      // clamps), hold the tall layout, fold down, then switch the layout once.
      const toHeight = win.offsetHeight
      const toTop = contentTop()
      setStyle(win, "height", "var(--window-max-h)")
      const fromHeight = win.offsetHeight
      const fromTop = contentTop()
      if (fromHeight - toHeight < 1) {
        setStyle(win, "height", "")
        return
      }
      if (!win.hasAttribute("data-folding")) startFold(win)
      const fold = foldFor(fromHeight - toHeight - values.edge.get())
      play(
        "fold",
        [
          [values.edge, fromHeight - toHeight, fold],
          [values.shift, Math.max(0, toTop - fromTop), fold],
        ],
        () => {
          setStyle(win, "height", "")
          follow()
          values.edge.jump(0)
          values.shift.jump(0)
          win.removeAttribute("data-folding")
        }
      )
      return
    }

    if (was.contentKey !== contentKey && !reduce) {
      // Another chat takes the window: it fades in as one layer, never turn by turn.
      values.content.jump(0)
      afterFirstPaint(() => {
        animate(values.content, 1, SWAP_IN)
      })
    }
  }, [
    surface,
    expanded,
    contentKey,
    values,
    windowRef,
    barRef,
    launcherRef,
    followingRef,
  ])
}