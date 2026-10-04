import type {
  Mark as ProseMirrorMark,
  Node as ProseMirrorNode,
} from "@tiptap/pm/model"
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { Extension, type Editor, type JSONContent } from "@tiptap/react"

import { firstReplaceAt, locateText, type AssistEdit } from "./assist-plans"
import {
  readChanges,
  SUGGESTION_DELETE,
  SUGGESTION_INSERT,
} from "./rich-text-changes"

const assistCursorKey = new PluginKey<number | null>("assistCursor")

// One line tall, and a negative end margin so it never nudges the text.
const CARET =
  "pointer-events-none relative -me-0.5 inline-block h-lh w-0.5 bg-primary align-top select-none"
const FLAG =
  "absolute start-0 bottom-full mb-1 rounded-full bg-primary px-1.5 text-xs/4 font-medium whitespace-nowrap text-primary-foreground"

function caretElement(label: string) {
  const caret = document.createElement("span")
  caret.className = CARET
  caret.setAttribute("aria-hidden", "true")
  const flag = document.createElement("span")
  flag.className = FLAG
  flag.textContent = label
  caret.append(flag)
  return caret
}

interface AssistCursorOptions {
  label: string
}

/** The agent's caret: a labelled bar at the point it is writing. */
export const AssistCursor = Extension.create<AssistCursorOptions>({
  name: "assistCursor",

  addOptions() {
    return { label: "Assist" }
  },

  addProseMirrorPlugins() {
    const { label } = this.options
    return [
      new Plugin<number | null>({
        key: assistCursorKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const next = tr.getMeta(assistCursorKey) as
              number | null | undefined
            if (next !== undefined) return next
            return value === null ? null : tr.mapping.map(value)
          },
        },
        props: {
          decorations(state) {
            const pos = assistCursorKey.getState(state)
            if (pos == null) return null
            return DecorationSet.create(state.doc, [
              Decoration.widget(pos, () => caretElement(label), {
                side: 1,
                key: "assist-cursor",
              }),
            ])
          },
        },
      }),
    ]
  },
})

export interface StreamProgress {
  /** Edits finished, including skipped ones. */
  done: number
  total: number
}

export interface StreamResult {
  applied: number
  skipped: number
  stopped: boolean
}

interface StreamOptions {
  signal: AbortSignal
  /** Instant edits: reduced motion, or a host that wants no animation. */
  instant: boolean
  onProgress: (progress: StreamProgress) => void
}

const WORD_MS = 45
const STRIKE_MS = 260
const BETWEEN_MS = 420
// Long enough for a smooth scroll to land before the first word is written.
const TRAVEL_MS = 480

/** Resolves after `ms`, or at once when the run is stopped. */
export function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted || ms === 0) {
      resolve()
      return
    }
    function stop() {
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", stop)
      resolve()
    }, ms)
    signal.addEventListener("abort", stop, { once: true })
  })
}

/** Runs one transaction as the agent: tracking on for exactly this dispatch,
 * so a keystroke between two words is never stamped as the agent's. */
function dispatchAsAgent(
  editor: Editor,
  build: (tr: Transaction) => number | null
) {
  const storage = editor.storage.richTextChanges
  const tr = editor.state.tr
  const caret = build(tr)
  if (caret !== null) tr.setSelection(TextSelection.create(tr.doc, caret))
  tr.setMeta(assistCursorKey, caret)
  storage.tracking = true
  try {
    editor.view.dispatch(tr)
  } finally {
    storage.tracking = false
  }
}

// The nearest inner scroller; the page's own root scrolls through window.
function scrollParent(editor: Editor) {
  let node = editor.view.dom.parentElement
  while (node && node !== document.body && node !== document.documentElement) {
    const { overflowY } = getComputedStyle(node)
    if (
      /auto|scroll/.test(overflowY) &&
      node.scrollHeight > node.clientHeight
    ) {
      return node
    }
    node = node.parentElement
  }
  return null
}

function scrollMargins(editor: Editor) {
  const margin = editor.view.someProp("scrollMargin")
  return typeof margin === "number"
    ? { top: margin, bottom: margin }
    : { top: margin?.top ?? 0, bottom: margin?.bottom ?? 0 }
}

/** The view's own scroll needs focus, which stays in the dock during a run;
 * a new spot is centred smoothly, each word only nudges. */
function keepInView(
  editor: Editor,
  pos: number,
  { travel, instant }: { travel: boolean; instant: boolean }
) {
  if (pos > editor.state.doc.content.size) return false
  // An inner scroller when the host has one, otherwise the page itself.
  const box = scrollParent(editor)
  const caret = editor.view.coordsAtPos(pos)
  const frame = box?.getBoundingClientRect() ?? {
    top: 0,
    bottom: window.innerHeight,
  }
  const margin = scrollMargins(editor)
  const high = frame.top + margin.top
  const low = frame.bottom - margin.bottom
  if (caret.top >= high && caret.bottom <= low) return false
  const delta = travel
    ? caret.top - (high + low) / 2
    : caret.bottom > low
      ? caret.bottom - low
      : caret.top - high
  const target = box ?? window
  target.scrollBy({
    top: delta,
    behavior: travel && !instant ? "smooth" : "auto",
  })
  return true
}

/** Moves the view to where the next edit lands, then lets it settle. */
async function travelTo(editor: Editor, pos: number, options: StreamOptions) {
  const moved = keepInView(editor, pos, {
    travel: true,
    instant: options.instant,
  })
  if (moved && !options.instant) await sleep(TRAVEL_MS, options.signal)
}

function markIdAt(editor: Editor, pos: number, type: string) {
  const node = editor.state.doc.nodeAt(pos)
  const mark = node?.marks.find(
    (candidate: ProseMirrorMark) => candidate.type.name === type
  )
  return mark ? String(mark.attrs.id) : null
}

function changeEnd(editor: Editor, id: string) {
  return (
    readChanges(editor.state.doc).find((change) => change.id === id)?.to ?? null
  )
}

function tokens(value: string, instant: boolean) {
  return instant ? [value] : (value.match(/\S+\s*/g) ?? [value])
}

/** Streams words onto the end of change `id`, one dispatch per word. */
async function streamOnto(
  editor: Editor,
  id: string,
  words: string[],
  { signal, instant }: StreamOptions
) {
  for (const word of words) {
    if (signal.aborted) return
    const end = changeEnd(editor, id)
    if (end === null) return
    dispatchAsAgent(editor, (tr) => {
      tr.insert(end, editor.schema.text(word))
      return end + word.length
    })
    keepInView(editor, end + word.length, { travel: false, instant })
    await sleep(instant ? 0 : WORD_MS, signal)
  }
}

/** End of the last line of text inside a block inserted at `at`. */
function lastTextEnd(node: ProseMirrorNode, at: number) {
  let end = at + node.nodeSize
  let current: ProseMirrorNode | null = node
  while (current && !current.isTextblock) {
    end -= 1
    current = current.lastChild
  }
  return end - 1
}

/** Inserts a block with its first word, then streams the rest into it. */
async function insertBlock(
  editor: Editor,
  at: number,
  build: (first: JSONContent[]) => JSONContent,
  lead: JSONContent[],
  text: string,
  options: StreamOptions
) {
  const [first = "", ...rest] = tokens(text, options.instant)
  const node = editor.schema.nodeFromJSON(
    build([...lead, { type: "text", text: first }])
  )
  const caret = lastTextEnd(node, at)
  await travelTo(editor, Math.min(at, editor.state.doc.content.size), options)
  if (options.signal.aborted) return null
  dispatchAsAgent(editor, (tr) => {
    tr.insert(at, node)
    return caret
  })
  keepInView(editor, caret, { travel: false, instant: options.instant })
  const id = markIdAt(editor, caret - 1, SUGGESTION_INSERT)
  if (!id) return null
  await sleep(options.instant ? 0 : WORD_MS, options.signal)
  await streamOnto(editor, id, rest, options)
  return id
}

async function applyReplace(
  editor: Editor,
  edit: Extract<AssistEdit, { kind: "replace" }>,
  from: number,
  options: StreamOptions
) {
  const range = locateText(editor.state.doc, edit.find, {
    from,
    whole: edit.whole,
  })
  if (!range) return null
  // Strike first, so the reader sees what goes before what replaces it.
  // The engine puts the struck text back; the caret maps past it.
  dispatchAsAgent(editor, (tr) => {
    tr.delete(range.from, range.to)
    return range.from
  })
  const id = markIdAt(editor, range.from, SUGGESTION_DELETE)
  if (!id) return null
  await sleep(options.instant ? 0 : STRIKE_MS, options.signal)
  await streamOnto(editor, id, tokens(edit.text, options.instant), options)
  return changeEnd(editor, id)
}

function topBlocks(editor: Editor) {
  const blocks: { node: ProseMirrorNode; pos: number }[] = []
  editor.state.doc.forEach((node, pos) => blocks.push({ node, pos }))
  return blocks
}

// The end of the first top-level line: the title, in this plan.
function titleEnd(editor: Editor) {
  const title = topBlocks(editor).find(({ node }) => node.isTextblock)
  return title ? title.pos + title.node.nodeSize : 0
}

function headingStart(editor: Editor, text: string) {
  const heading = topBlocks(editor).find(
    ({ node }) =>
      node.type.name === "heading" && node.textContent.trim() === text
  )
  return heading?.pos ?? null
}

async function applySummary(
  editor: Editor,
  edit: Extract<AssistEdit, { kind: "summary" }>,
  options: StreamOptions
) {
  // Under the title; a plan without one takes it at the top.
  const at = titleEnd(editor)
  const id = await insertBlock(
    editor,
    at,
    (content) => ({ type: "paragraph", content }),
    [
      { type: "text", text: edit.label, marks: [{ type: "bold" }] },
      { type: "text", text: " " },
    ],
    edit.text,
    options
  )
  return id ? changeEnd(editor, id) : null
}

function taskListEnd(editor: Editor, inside: number) {
  const $pos = editor.state.doc.resolve(inside)
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === "taskList") return $pos.end(depth)
  }
  return null
}

function headingWithNext(editor: Editor, text: string) {
  const blocks = topBlocks(editor)
  const index = blocks.findIndex(
    ({ node }) =>
      node.type.name === "heading" && node.textContent.trim() === text
  )
  const heading = blocks[index]
  if (!heading) return null
  return { end: heading.pos + heading.node.nodeSize, next: blocks[index + 1] }
}

function task(content: JSONContent[]): JSONContent {
  return {
    type: "taskItem",
    attrs: { checked: false },
    content: [{ type: "paragraph", content }],
  }
}

/** Tasks join a list that already holds one of them, the list under an
 * existing heading, or a new heading and list above `before`. */
async function applyChecklist(
  editor: Editor,
  edit: Extract<AssistEdit, { kind: "checklist" }>,
  options: StreamOptions
) {
  // Inside a list the tasks join; inserts land after it, so it never moves.
  let listAnchor = edit.listWith
    ? (locateText(editor.state.doc, edit.listWith)?.from ?? null)
    : null
  let newListAt: number | null = null

  if (listAnchor === null && edit.addHeading) {
    const at =
      headingStart(editor, edit.before) ?? editor.state.doc.content.size
    const headingId = await insertBlock(
      editor,
      at,
      (content) => ({ type: "heading", attrs: { level: 2 }, content }),
      [],
      edit.heading,
      options
    )
    if (!headingId || options.signal.aborted) return null
    const end = changeEnd(editor, headingId)
    if (end === null) return null
    newListAt = editor.state.doc.resolve(end).after()
  } else if (listAnchor === null) {
    const heading = headingWithNext(editor, edit.heading)
    if (!heading) return null
    if (heading.next?.node.type.name === "taskList") {
      listAnchor = heading.next.pos + 1
    } else {
      newListAt = heading.end
    }
  }

  // Each task is its own suggestion, so a reviewer can keep some of them.
  let cursor: number | null = null
  for (const item of edit.items) {
    if (options.signal.aborted) break
    await sleep(options.instant ? 0 : BETWEEN_MS / 2, options.signal)
    const at = listAnchor === null ? newListAt : taskListEnd(editor, listAnchor)
    if (at === null) break
    const id = await insertBlock(
      editor,
      at,
      listAnchor === null
        ? (content) => ({ type: "taskList", content: [task(content)] })
        : task,
      [],
      item,
      options
    )
    if (!id) break
    cursor = changeEnd(editor, id)
    listAnchor ??= cursor
  }
  return cursor
}

/** Applies a plan as tracked suggestions, word by word, until done or stopped. */
export async function streamEdits(
  editor: Editor,
  edits: AssistEdit[],
  options: StreamOptions
): Promise<StreamResult> {
  let applied = 0
  let skipped = 0
  // The first planned spot, which may sit just before a selection's start.
  let from = firstReplaceAt(edits)
  options.onProgress({ done: 0, total: edits.length })
  try {
    for (const [index, edit] of edits.entries()) {
      if (options.signal.aborted) break
      if (index > 0)
        await sleep(options.instant ? 0 : BETWEEN_MS, options.signal)
      if (options.signal.aborted) break
      const end =
        edit.kind === "replace"
          ? await applyReplace(editor, edit, from, options)
          : edit.kind === "summary"
            ? await applySummary(editor, edit, options)
            : await applyChecklist(editor, edit, options)
      if (end === null) {
        skipped += 1
      } else {
        applied += 1
        from = end
      }
      options.onProgress({ done: index + 1, total: edits.length })
    }
  } finally {
    // The caret leaves with the run, stopped or not.
    if (!editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta(assistCursorKey, null))
    }
  }
  return { applied, skipped, stopped: options.signal.aborted }
}