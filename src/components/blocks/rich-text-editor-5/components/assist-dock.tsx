import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react"
import { Frame, FrameHeader } from "@/components/reui/frame"
import { cn } from "cn"
import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  type MotionValue,
} from "motion/react"

// The frame's own translucent band, frosted and desaturated, so text passing
// under the dock blurs to neutral instead of tinting the band.
const FROST = "backdrop-blur-md backdrop-saturate-50"

export const FOLD_OPEN = {
  type: "spring",
  visualDuration: 0.26,
  bounce: 0,
} as const
export const FOLD_CLOSE = { duration: 0.16, ease: [0.4, 0, 1, 1] } as const

export const BAND = {
  open: { transition: { delayChildren: 0.04, staggerChildren: 0.03 } },
  closed: {},
}

export const BAND_ITEM = {
  open: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
  },
  closed: { opacity: 0, y: 6, transition: { duration: 0.1 } },
} as const

// The frame's visible top while a band folds; the clip and light share it.
const FOLD_TOP =
  "[--fold-top:max(0px,calc(var(--fold-h,0px)-var(--fold-shown,0px)))]"

// clip-path, not height: the band grows the dock upward while the line stays
// put, and a FLIP would squash this frosted frame's var() radius.
const FOLD_CLIP =
  "group-data-folding/dock:[clip-path:inset(var(--fold-top)_0_0_0_round_var(--frame-radius))]"

// Each state raises its own glow level and the brightest wins, so a hover
// never dims a focused dock; working stays the brightest.
const LIGHT_LEVELS = cn(
  "[--glow:max(var(--glow-hover,0),var(--glow-focus,0),var(--glow-press,0),var(--glow-work,0))]",
  "hover:[--glow-hover:0.3] focus-within:[--glow-focus:0.55] has-[[aria-haspopup][aria-expanded=true]]:[--glow-focus:0.55] active:[--glow-press:0.65] data-working:[--glow-work:0.75]"
)

const SPECTRUM =
  "[--dock-spectrum:conic-gradient(in_oklch,var(--color-sky-400),var(--color-violet-500),var(--color-fuchsia-500),var(--color-rose-400),var(--color-amber-300),var(--color-sky-400))] dark:[--dock-spectrum:conic-gradient(in_oklch,var(--color-sky-300),var(--color-violet-400),var(--color-fuchsia-400),var(--color-rose-300),var(--color-amber-200),var(--color-sky-300))]"

// A square of at least w + h covers its box at any angle; the width term
// holds it steady while a band folds, so the fold never re-rasters it.
const SPIN =
  "absolute top-1/2 left-1/2 size-[max(125cqw,100cqw+100cqh)] -translate-1/2 bg-(image:--dock-spectrum) animate-[spin_7s_linear_infinite] motion-reduce:animate-none"

// The content box, cut out of the border box, leaves only the padding ring.
// A mask never clips scroll overflow, so the turning square needs the clip.
const RING_MASK =
  "overflow-clip [mask:linear-gradient(#000_0_0)_content-box_exclude,linear-gradient(#000_0_0)]"

// Runs the light faster while Assist works; the rate change keeps its angle.
const WORKING_RATE = 2.5

interface Fold {
  host: RefObject<HTMLDivElement | null>
  shown: MotionValue<number>
  reduce: boolean
}

const FoldContext = createContext<Fold | null>(null)

interface AssistDockProps {
  /** The live turn (running, review or answer); null shows the composer. */
  turn: ReactNode
  composer: ReactNode
  /** A run is live: the light brightens and turns faster. */
  working: boolean
  /** Announced once per change: the last review decision. */
  status: string
  dockRef?: Ref<HTMLDivElement>
  /** Whether focus is inside the dock, so a panel swap can carry it over. */
  onFocusWithinChange?: (within: boolean) => void
  className?: string
}

/** Floats over the page's lower edge; one turn above, or the composer. */
export function AssistDock({
  turn,
  composer,
  working,
  status,
  dockRef,
  onFocusWithinChange,
  className,
}: AssistDockProps) {
  const reduce = useReducedMotion() ?? false
  const host = useRef<HTMLDivElement>(null)
  const shown = useMotionValue(0)
  const fold = useMemo(() => ({ host, shown, reduce }), [shown, reduce])

  // Straight to the style, so a fold never re-renders React.
  useMotionValueEvent(shown, "change", (value) => {
    host.current?.style.setProperty("--fold-shown", `${value}px`)
  })

  useEffect(() => {
    const lights = host.current?.querySelectorAll("[data-dock-light]") ?? []
    for (const light of lights) {
      for (const spin of light.getAnimations()) {
        spin.updatePlaybackRate(working ? WORKING_RATE : 1)
      }
    }
  }, [working])

  return (
    <div
      ref={dockRef}
      onFocus={() => onFocusWithinChange?.(true)}
      // A control that unmounts fires no blur, so focus still counts as here.
      onBlur={(event) => {
        const next = event.relatedTarget
        if (
          next ? !event.currentTarget.contains(next) : event.target.isConnected
        ) {
          onFocusWithinChange?.(false)
        }
      }}
      className={cn(
        "pointer-events-none sticky bottom-3 z-10 flex justify-center pt-6 sm:bottom-5",
        className
      )}
    >
      {/* Hosts the fold and the light, so the glow sits outside the clip. */}
      <div
        ref={host}
        data-working={working ? "" : undefined}
        className={cn(
          "group/dock relative w-full max-w-xl",
          FOLD_TOP,
          LIGHT_LEVELS,
          SPECTRUM
        )}
      >
        {/* Square-cornered, so it needs no radius from inside the frame;
            the blur hides the difference at the corners. */}
        <div
          aria-hidden="true"
          // top, not a translate: the glow shrinks to hug the visible top.
          className="pointer-events-none absolute inset-x-0 top-(--fold-top) bottom-0 opacity-(--glow) blur-md transition-opacity duration-300"
        >
          <div
            className={cn("@container-size absolute inset-0 p-1", RING_MASK)}
          >
            <span data-dock-light className={SPIN} />
          </div>
        </div>
        <Frame
          dense
          spacing="default"
          role="region"
          aria-label="Assist"
          className={cn(FROST, FOLD_CLIP, "pointer-events-auto w-full")}
        >
          {/* Overlays first: the dense frame pulls only its last child flush
              with the bottom border, and that is the turn's panel. */}
          <div
            aria-hidden="true"
            // top, not a translate: the ring shrinks with the fold so its top
            // edge stays closed; it rests at 0.7 and any lit state goes full.
            className={cn(
              "@container-size pointer-events-none absolute -inset-x-px top-[calc(var(--fold-top)-1px)] -bottom-px z-10 rounded-(--frame-radius) p-px opacity-[clamp(0.7,calc(var(--glow)*10),1)] transition-opacity duration-300",
              RING_MASK
            )}
          >
            <span data-dock-light className={SPIN} />
          </div>
          {/* Mounted before any outcome, so its first text is announced. */}
          <span role="status" className="sr-only">
            {status}
          </span>
          <FoldContext value={fold}>{turn ?? composer}</FoldContext>
        </Frame>
      </div>
    </div>
  )
}

interface DockBandProps extends Omit<ComponentProps<"header">, "children"> {
  open: boolean
  /** Keeps the band interactive while it folds away before a run starts. */
  sending?: boolean
  /** Runs once the band has folded shut and unmounted. */
  onFolded?: () => void
  children: ReactNode
}

/** A header band that unfolds upward out of the line below it. */
export function DockBand({
  open,
  sending = false,
  onFolded,
  children,
  className,
  ...props
}: DockBandProps) {
  const fold = useContext(FoldContext)
  const band = useRef<HTMLElement>(null)
  const openRef = useRef(open)
  const foldedRef = useRef(onFolded)
  const heightRef = useRef(0)
  // A band that is open on its first render (after a review) lands instantly.
  const landedRef = useRef(open)
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)

  useLayoutEffect(() => {
    openRef.current = open
    foldedRef.current = onFolded
  })

  // Measured after layout, before paint, so a new band is clipped on its first
  // frame; the vars go straight to the host, never through React state.
  useLayoutEffect(() => {
    const element = band.current
    const host = fold?.host.current
    if (!mounted || !fold || !element || !host) return

    host.dataset.folding = ""
    const observer = new ResizeObserver(() => {
      const line = element.nextElementSibling
      const height = line
        ? line.getBoundingClientRect().top - host.getBoundingClientRect().top
        : 0
      heightRef.current = height
      host.style.setProperty("--fold-h", `${height}px`)
      if (landedRef.current) {
        landedRef.current = false
        fold.shown.jump(height)
      } else if (openRef.current) {
        animate(fold.shown, height, fold.reduce ? { duration: 0 } : FOLD_OPEN)
      }
    })
    observer.observe(element)

    return () => {
      observer.disconnect()
      delete host.dataset.folding
      host.style.setProperty("--fold-h", "0px")
      fold.shown.jump(0)
    }
  }, [mounted, fold])

  // Reopened mid-fold: the size is unchanged, so no resize will retarget it.
  useEffect(() => {
    if (!open || !mounted || !fold || heightRef.current === 0) return
    const controls = animate(
      fold.shown,
      heightRef.current,
      fold.reduce ? { duration: 0 } : FOLD_OPEN
    )
    return () => controls.stop()
  }, [open, mounted, fold])

  useEffect(() => {
    if (open || !mounted || !fold) return
    const controls = animate(
      fold.shown,
      0,
      fold.reduce ? { duration: 0 } : FOLD_CLOSE
    )
    // State-guarded: a band reopened during the fold is never unmounted.
    controls.then(() => {
      if (openRef.current || fold.shown.get() !== 0) return
      setMounted(false)
      foldedRef.current?.()
    })
    return () => controls.stop()
  }, [open, mounted, fold])

  if (!mounted) return null

  return (
    <FrameHeader
      ref={band}
      inert={!open && !sending ? true : undefined}
      className={className}
      {...props}
    >
      <motion.div
        initial={fold?.reduce ? false : "closed"}
        animate={open ? "open" : "closed"}
        variants={fold?.reduce ? undefined : BAND}
        className="flex min-w-0 flex-col gap-1.5"
      >
        {children}
      </motion.div>
    </FrameHeader>
  )
}