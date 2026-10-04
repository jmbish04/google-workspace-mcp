"use client"

/**
 * Agentic document editing on Tiptap: Assist reads the plan, writes its edits
 * into the text as suggestions and hands each one back for a decision.
 * Customize: swap planAction (assist-plans.ts) for your model, DOCUMENT in data.tsx.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  isTextSelection,
  useEditor,
  type Editor,
  type JSONContent,
} from "@tiptap/react"
import { cn } from "cn"

import { TooltipProvider } from "@/components/ui/tooltip"

import { AssistAnswerView, type AssistAnswer } from "./assist-answer"
import { AssistBubble } from "./assist-bubble"
import { AssistComposer, type AssistOutcome } from "./assist-composer"
import { AssistDock } from "./assist-dock"
import {
  locateText,
  matchAction,
  planAction,
  plural,
  previewReadouts,
  selectionWords,
  type AssistFinding,
  type AssistScope,
  type AssistSummary,
} from "./assist-plans"
import { AssistProgress } from "./assist-progress"
import type { AssistRequest } from "./assist-request"
import { AssistReview } from "./assist-review"
import {
  AssistCursor,
  sleep,
  streamEdits,
  type StreamProgress,
} from "./assist-stream"
// customize: the plan, its people, the agent and the clock
import {
  AGENT,
  ASSIST_ACTIONS,
  currentTime,
  DOC_META,
  DOCUMENT,
  SEEDED_RUN,
  type AssistActionId,
} from "./data"
import { DocHeader } from "./doc-header"
import {
  readChanges,
  RICH_TEXT_CHANGES_PROSE,
  RICH_TEXT_MARKUP_VIEW,
  RichTextChanges,
  useRichTextChanges,
  type RichTextMarkupView,
  type SuggestionResolution,
} from "./rich-text-changes"
import { RichTextContent } from "./rich-text-content"
import { createRichTextExtensions } from "./rich-text-extensions"
import { RichTextLinkBubble } from "./rich-text-link"
import { useRichTextSelector } from "./rich-text-state"

// Module scope: useEditor compares these by identity on every render.
const EXTENSIONS = [
  ...createRichTextExtensions({ placeholder: `Write, or ask ${AGENT.name}` }),
  // Your typing applies directly; tracking is on only for the agent's writes.
  RichTextChanges.configure({
    author: AGENT.id,
    tracking: false,
    now: currentTime,
  }),
  AssistCursor.configure({ label: AGENT.name }),
]

const EDITOR_PROPS = {
  attributes: {
    "aria-label": `${DOC_META.title} ${DOC_META.kind.toLowerCase()}`,
    "aria-multiline": "true",
  },
}

// How long each step of a run holds before the next one lands.
const STEP_MS = 520

type SelectionScope = AssistScope & { words: number }

interface RunState {
  request: AssistRequest
  steps: string[]
  shown: number
  progress: StreamProgress | null
}

interface ReviewState {
  summary: AssistSummary
  /** Review later folds it into the composer's Review button. */
  open: boolean
}

type Tally = Record<SuggestionResolution, number>

/** The dock's outcome line plus what Undo has to take back out of the tally. */
interface Decision extends AssistOutcome {
  resolution: SuggestionResolution
  count: number
}

function readScope(editor: Editor | null): SelectionScope | null {
  if (!editor) return null
  const { selection, doc } = editor.state
  if (!isTextSelection(selection) || selection.empty) return null
  if (!doc.textBetween(selection.from, selection.to, " ").trim()) return null
  const scope = { from: selection.from, to: selection.to }
  return { ...scope, words: selectionWords(doc, scope) }
}

function scopeLabel(scope: SelectionScope | null) {
  return scope ? `Selection, ${plural(scope.words, "word")}` : "Whole plan"
}

function describeTally({ accept, reject }: Tally) {
  if (accept && reject) return `Accepted ${accept}, rejected ${reject}`
  return accept
    ? `Accepted ${plural(accept, "edit")}`
    : `Rejected ${plural(reject, "edit")}`
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

interface DocAssistantProps {
  className?: string
  /** The document to open; read once, when the editor is created. */
  content?: JSONContent
}

export function DocAssistant({
  className,
  content = DOCUMENT,
}: DocAssistantProps) {
  const [prompt, setPrompt] = useState("")
  const [run, setRun] = useState<RunState | null>(null)
  const [answer, setAnswer] = useState<AssistAnswer | null>(null)
  const [review, setReview] = useState<ReviewState>({
    summary: SEEDED_RUN.summary,
    open: true,
  })
  const [tally, setTally] = useState<Tally>({ accept: 0, reject: 0 })
  const [outcome, setOutcome] = useState<Decision | null>(null)
  const [traceOpen, setTraceOpen] = useState(false)
  const [markup, setMarkup] = useState<RichTextMarkupView>("all")
  const quietFocusRef = useRef(false)
  const [readouts, setReadouts] = useState<
    Partial<Record<AssistActionId, string>>
  >({})
  const [edited, setEdited] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  const headerRef = useRef<HTMLElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const stopRef = useRef<HTMLButtonElement>(null)
  const acceptRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const shownModeRef = useRef<string | null>(null)
  const dockFocusRef = useRef(false)

  const editor = useEditor({
    extensions: EXTENSIONS,
    content,
    editorProps: EDITOR_PROPS,
    immediatelyRender: false,
    onUpdate: ({ transaction }) => {
      // A lock or unlock emits an update too; only edits restamp the header.
      if (!transaction.docChanged) return
      setEdited(true)
      // Undo takes back the newest step, so it is offered only while the
      // decision still is the newest; a decision sets it again right after.
      setOutcome(null)
    },
  })

  const { changes, activeId } = useRichTextChanges(editor)
  const scope = useRichTextSelector(editor, readScope)
  const editable = useRichTextSelector(
    editor,
    (current) => current?.isEditable ?? true
  )
  const pending = changes.length
  const mode = run
    ? "running"
    : answer
      ? "answer"
      : pending > 0 && review.open
        ? "review"
        : "idle"

  // A run outliving the block would keep writing into a destroyed editor.
  useEffect(() => () => controllerRef.current?.abort(), [])

  // The sticky header covers the page's top and the dock its lower edge, so
  // the caret and the agent's writing scroll clear of both, at any height.
  useLayoutEffect(() => {
    const header = headerRef.current
    const dock = dockRef.current
    if (!header || !dock) return

    const heights = { header: 0, dock: 0 }

    function measure() {
      heights.header = header?.getBoundingClientRect().height ?? 0
      heights.dock = dock?.getBoundingClientRect().height ?? 0
      // isDestroyed is true until the view mounts, and setProps needs the view.
      if (!editor || editor.isDestroyed) return
      editor.view.setProps({
        scrollThreshold: {
          top: heights.header + 16,
          right: 0,
          bottom: heights.dock + 16,
          left: 0,
        },
        scrollMargin: {
          top: heights.header + 32,
          right: 0,
          bottom: heights.dock + 32,
          left: 0,
        },
      })
    }

    measure()
    editor?.on("mount", measure)

    const observer = new ResizeObserver(measure)
    observer.observe(header)
    observer.observe(dock)

    return () => {
      observer.disconnect()
      editor?.off("mount", measure)
    }
  }, [editor])

  // A panel swap unmounts the focused control; focus follows to the new
  // panel's main action, but only when it was in the dock to begin with.
  useEffect(() => {
    // The first mode (and Strict Mode's second pass over it) moves nothing.
    const previous = shownModeRef.current
    shownModeRef.current = mode
    if (previous === null || previous === mode || !dockFocusRef.current) return
    const target = {
      running: stopRef.current,
      review: acceptRef.current,
      answer: closeRef.current,
      idle: fieldRef.current,
    }[mode]
    // Back on the line, focus lands without unfolding the task band.
    if (mode === "idle") {
      quietFocusRef.current = document.activeElement !== fieldRef.current
    }
    target?.focus({ preventScroll: true })
  }, [mode])

  function scrollToPos(pos: number) {
    if (!editor) return
    const { node } = editor.view.domAtPos(pos)
    const element = node instanceof Element ? node : node.parentElement
    element?.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    })
  }

  async function runAction(
    id: AssistActionId,
    { label, fromDock = true }: { label?: string; fromDock?: boolean } = {}
  ) {
    const action = ASSIST_ACTIONS.find((candidate) => candidate.id === id)
    if (!editor || !action || controllerRef.current) return

    const runScope = action.scoped && scope ? scope : null
    const request = {
      label: label ?? action.label,
      scope: scopeLabel(runScope),
    }
    const plan = planAction(id, editor.state.doc, runScope)
    const controller = new AbortController()
    const { signal } = controller
    controllerRef.current = controller

    // The Tasks menu and chips hold focus outside the dock's own tree, so a
    // run asked from the dock hands focus to Stop by intent, not by position.
    dockFocusRef.current = fromDock
    setPrompt("")
    setAnswer(null)
    setOutcome(null)
    // Final or Original would hide the words as they land.
    setMarkup("all")
    setRun({ request, steps: plan.steps, shown: 1, progress: null })
    editor.setEditable(false)

    try {
      for (let shown = 2; shown <= plan.steps.length; shown++) {
        await sleep(STEP_MS, signal)
        if (signal.aborted) break
        setRun((current) => current && { ...current, shown })
      }
      await sleep(STEP_MS, signal)

      if (plan.answer) {
        if (!signal.aborted) setAnswer(plan.answer)
        return
      }
      if (signal.aborted) return

      const result = await streamEdits(editor, plan.edits, {
        signal,
        instant: prefersReducedMotion(),
        onProgress: (progress) => {
          setRun((current) => current && { ...current, progress })
        },
      })

      if (result.applied > 0) {
        // Review starts at the top, wherever the agent stopped writing.
        const first = readChanges(editor.state.doc)[0]
        if (first) revealChange(first.id)
        setTally({ accept: 0, reject: 0 })
        setReview({
          open: true,
          summary: result.stopped ? { title: "Stopped early" } : plan.summary,
        })
      } else if (!result.stopped) {
        setAnswer({
          title: "Nothing changed",
          findings: [],
          note: "The text moved while I was reading it. Run the task again.",
        })
      }
    } finally {
      if (!editor.isDestroyed) editor.setEditable(true)
      controllerRef.current = null
      setRun(null)
    }
  }

  function submitPrompt(text: string) {
    const id = matchAction(text)
    if (id) {
      void runAction(id, { label: text })
      return
    }
    setPrompt("")
    setOutcome(null)
    setAnswer({
      title: "Pick a task",
      findings: [],
      note: "I can edit, add to or review this plan. Try one of these.",
      actions: ["tighten", "summary", "questions"],
    })
  }

  // Selects the change and centers it; the DOM scroll works while focus
  // stays in the dock, where the view's own would not.
  function revealChange(id: string) {
    if (!editor?.commands.selectChange(id)) return
    const target = editor.view.dom.querySelector(
      `[data-id="${CSS.escape(id)}"]`
    )
    target?.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    })
  }

  // Instant and undoable; the last decision reports the tally.
  function resolveOne(id: string, resolution: SuggestionResolution) {
    if (!editor) return
    const index = changes.findIndex((change) => change.id === id)
    const next = changes[index + 1] ?? changes[index - 1]
    const done =
      resolution === "accept"
        ? editor.commands.acceptChange(id)
        : editor.commands.rejectChange(id)
    if (!done) return

    const nextTally = { ...tally, [resolution]: tally[resolution] + 1 }
    setTally(nextTally)
    if (next) {
      revealChange(next.id)
    } else {
      releaseSelection()
      setOutcome({ text: describeTally(nextTally), resolution, count: 1 })
    }
  }

  function resolveAll(resolution: SuggestionResolution) {
    if (!editor) return
    // Its menu holds focus outside the dock's tree; the ask still came from it.
    dockFocusRef.current = true
    const count = changes.length
    const done =
      resolution === "accept"
        ? editor.commands.acceptAllChanges()
        : editor.commands.rejectAllChanges()
    if (!done) return
    releaseSelection()
    const nextTally = { ...tally, [resolution]: tally[resolution] + count }
    setTally(nextTally)
    setOutcome({ text: describeTally(nextTally), resolution, count })
  }

  // The reviewed change was selected; once decided, the selection would
  // otherwise read as a scope the writer never chose.
  function releaseSelection() {
    if (!editor) return
    editor.commands.setTextSelection(editor.state.selection.to)
  }

  // A jump selects its finding while the answer is open; closing lets go, so
  // the next run is not quietly scoped to it.
  function closeAnswer() {
    releaseSelection()
    setAnswer(null)
  }

  // Back to the line from any panel, the selection still held as the scope;
  // the panel swap moves focus to the field, or it goes there now.
  function askAssist() {
    if (run) return
    dockFocusRef.current = true
    setAnswer(null)
    setReview((current) => ({ ...current, open: false }))
    if (mode === "idle") fieldRef.current?.focus()
  }

  function deferReview() {
    releaseSelection()
    setReview((current) => ({ ...current, open: false }))
  }

  function undoDecision() {
    if (!editor || !outcome) return
    editor.commands.undo()
    const { resolution, count } = outcome
    setTally((current) => ({
      ...current,
      [resolution]: Math.max(0, current[resolution] - count),
    }))
    setOutcome(null)
  }

  function jumpTo(finding: AssistFinding) {
    if (!editor) return
    const range = locateText(editor.state.doc, finding.find)
    if (!range) return
    editor.commands.setTextSelection(range)
    scrollToPos(range.from)
  }

  function handleMenuOpen(open: boolean) {
    if (open && editor) setReadouts(previewReadouts(editor.state.doc, scope))
  }

  // Mod-K follows the toolbar: no link where marks are refused (code blocks).
  function openLinkFromKeyboard() {
    setLinkOpen(editable && Boolean(editor?.can().toggleBold()))
  }

  const turn =
    mode === "running" && run ? (
      <AssistProgress
        request={run.request}
        steps={run.steps}
        shown={run.shown}
        progress={run.progress}
        traceOpen={traceOpen}
        onTraceOpenChange={setTraceOpen}
        onStop={() => controllerRef.current?.abort()}
        stopRef={stopRef}
      />
    ) : mode === "answer" && answer ? (
      <AssistAnswerView
        answer={answer}
        onJump={jumpTo}
        onRun={(id) => void runAction(id)}
        onClose={closeAnswer}
        closeRef={closeRef}
      />
    ) : mode === "review" ? (
      <AssistReview
        summary={review.summary}
        changes={changes}
        activeId={activeId}
        onReveal={revealChange}
        onResolve={resolveOne}
        onResolveAll={resolveAll}
        onLater={deferReview}
        acceptRef={acceptRef}
      />
    ) : null

  return (
    <TooltipProvider delay={300}>
      <div
        className={cn(
          "bg-background text-foreground flex w-full flex-col",
          className
        )}
      >
        <DocHeader
          ref={headerRef}
          editor={editor}
          pending={pending}
          edited={edited}
          markup={markup}
          onMarkupChange={setMarkup}
          onAsk={askAssist}
          askDisabled={run !== null}
          linkOpen={linkOpen}
          onLinkOpenChange={setLinkOpen}
        />

        {/* The text sits on the page itself; the dock rides its lower edge. */}
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 sm:px-6">
          <RichTextContent
            editor={editor}
            onLinkShortcut={openLinkFromKeyboard}
            className={cn(
              RICH_TEXT_CHANGES_PROSE,
              RICH_TEXT_MARKUP_VIEW[markup],
              // A Contents jump stops below the two-row sticky header.
              "py-8 sm:py-10 [&_.tiptap_:is(h1,h2,h3)]:scroll-mt-32"
            )}
          />
          {editor ? (
            <>
              <RichTextLinkBubble
                editor={editor}
                onEdit={() => setLinkOpen(true)}
              />
              <AssistBubble
                editor={editor}
                onAsk={askAssist}
                onRun={(id) => void runAction(id, { fromDock: false })}
              />
            </>
          ) : null}
          <AssistDock
            dockRef={dockRef}
            onFocusWithinChange={(within) => {
              dockFocusRef.current = within
            }}
            turn={turn}
            working={run !== null}
            status={outcome?.text ?? ""}
            className="mt-auto"
            composer={
              <AssistComposer
                value={prompt}
                onValueChange={setPrompt}
                onSubmit={submitPrompt}
                onRun={(id) => void runAction(id)}
                scopeLabel={scopeLabel(scope)}
                scoped={scope !== null}
                readouts={readouts}
                onMenuOpenChange={handleMenuOpen}
                pending={review.open ? 0 : pending}
                onReview={() =>
                  setReview((current) => ({ ...current, open: true }))
                }
                outcome={outcome}
                onUndo={undoDecision}
                onDismissOutcome={() => setOutcome(null)}
                fieldRef={fieldRef}
                quietFocusRef={quietFocusRef}
              />
            }
          />
        </div>
      </div>
    </TooltipProvider>
  )
}