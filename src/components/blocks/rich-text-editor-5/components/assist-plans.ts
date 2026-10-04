import type { Node as ProseMirrorNode } from "@tiptap/pm/model"

import {
  ASSIST_ACTIONS,
  ASSIST_CHECKLIST,
  ASSIST_MISSPELLINGS,
  ASSIST_REWRITES,
  ASSIST_SUMMARY,
  PEOPLE,
  type AssistActionId,
  type PersonId,
} from "./data"
import { SUGGESTION_DELETE, SUGGESTION_INSERT } from "./rich-text-changes"

/** A document range the run is limited to; null reads the whole plan. */
export interface AssistScope {
  from: number
  to: number
}

export interface TextRange {
  from: number
  to: number
}

/** One textblock as a reader sees it: struck text left out. */
interface BlockText {
  node: ProseMirrorNode
  pos: number
  text: string
  /** Document position of each character, plus the end. */
  map: number[]
}

export type AssistEdit =
  | {
      kind: "replace"
      find: string
      whole: boolean
      text: string
      /** Where the plan found it; the stream searches from here, not scope. */
      at: number
    }
  | { kind: "summary"; label: string; text: string }
  | {
      kind: "checklist"
      heading: string
      /** False when the heading or some tasks are already in the plan. */
      addHeading: boolean
      before: string
      items: string[]
      /** A task already in a list; new tasks join that list. */
      listWith: string | null
    }

export interface AssistFinding {
  id: string
  text: string
  /** The heading above the finding, for orientation. */
  section: string
  /** Text the jump selects; located again at click time. */
  find: string
  person?: PersonId
  done?: boolean
}

/** The review header once the edits land: a short title, then the detail
 * (the live count of edits left when a run has nothing more specific). */
export interface AssistSummary {
  title: string
  detail?: string
}

export interface AssistPlan {
  steps: string[]
  edits: AssistEdit[]
  summary: AssistSummary
  /** Set when the run answers instead of editing. */
  answer?: { title: string; findings: AssistFinding[]; note?: string }
}

const NO_SUMMARY: AssistSummary = { title: "" }

function readBlocks(doc: ProseMirrorNode): BlockText[] {
  const blocks: BlockText[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let text = ""
    const map: number[] = []
    node.forEach((child, offset) => {
      const struck = child.marks.some(
        (mark) => mark.type.name === SUGGESTION_DELETE
      )
      if (!child.isText || struck) return
      const start = pos + 1 + offset
      for (let index = 0; index < (child.text ?? "").length; index++) {
        map.push(start + index)
      }
      text += child.text
    })
    map.push(pos + node.nodeSize - 1)
    blocks.push({ node, pos, text, map })
    return false
  })
  return blocks
}

function inScope(range: TextRange, scope: AssistScope | null) {
  return !scope || (range.from < scope.to && range.to > scope.from)
}

function rangeOf(block: BlockText, start: number, length: number): TextRange {
  const last = block.map[start + length - 1] ?? block.map[start] ?? block.pos
  return { from: block.map[start] ?? block.pos, to: last + 1 }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** First match at or after `from`; whole-word matches ignore substrings. */
export function locateText(
  doc: ProseMirrorNode,
  find: string,
  { from = 0, whole = false }: { from?: number; whole?: boolean } = {}
): TextRange | null {
  const pattern = new RegExp(
    whole ? `\\b${escapeRegExp(find)}\\b` : escapeRegExp(find),
    "g"
  )
  for (const block of readBlocks(doc)) {
    if (block.pos + block.node.nodeSize < from) continue
    for (const match of block.text.matchAll(pattern)) {
      const range = rangeOf(block, match.index, match[0].length)
      if (range.from >= from) return range
    }
  }
  return null
}

function countWords(value: string) {
  const words = value.trim().split(/\s+/).filter(Boolean)
  return words.length
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`
}

function sectionCount(doc: ProseMirrorNode) {
  let count = 0
  doc.descendants((node) => {
    if (node.type.name === "heading" && node.attrs.level === 2) count += 1
    return !node.isTextblock
  })
  return count
}

// Words a reader sees: struck suggestion text is left out.
function planWords(doc: ProseMirrorNode) {
  return readBlocks(doc).reduce(
    (total, block) => total + countWords(block.text),
    0
  )
}

/** Keeps the typo's capital so a sentence start stays one. */
function matchCase(original: string, fix: string) {
  return original[0] === original[0]?.toUpperCase()
    ? fix[0]?.toUpperCase() + fix.slice(1)
    : fix
}

function planProofread(
  doc: ProseMirrorNode,
  scope: AssistScope | null
): AssistPlan {
  const words = Object.keys(ASSIST_MISSPELLINGS)
  const pattern = new RegExp(`\\b(${words.join("|")})\\b`, "gi")
  const edits: AssistEdit[] = []
  for (const block of readBlocks(doc)) {
    for (const match of block.text.matchAll(pattern)) {
      const found = match[0]
      const range = rangeOf(block, match.index, found.length)
      if (!inScope(range, scope)) continue
      const fix = ASSIST_MISSPELLINGS[found.toLowerCase()] ?? found
      edits.push({
        kind: "replace",
        find: found,
        whole: true,
        text: matchCase(found, fix),
        at: range.from,
      })
    }
  }
  const read = scope
    ? `Read the selection, ${plural(selectionWords(doc, scope), "word")}`
    : `Read ${plural(sectionCount(doc), "section")}, ${plural(
        planWords(doc),
        "word"
      )}`
  if (edits.length === 0) {
    return {
      steps: [read, "Checked spelling"],
      edits,
      summary: NO_SUMMARY,
      answer: {
        title: "No typos found",
        findings: [],
        note: scope
          ? "The selection reads clean."
          : "Every word in the plan checks out.",
      },
    }
  }
  return {
    steps: [
      read,
      `Found ${plural(edits.length, "typo")}`,
      `Fixing ${plural(edits.length, "word")}`,
    ],
    edits,
    summary: { title: "Spelling fixed" },
  }
}

function planTighten(
  doc: ProseMirrorNode,
  scope: AssistScope | null
): AssistPlan {
  const found = ASSIST_REWRITES.flatMap((rewrite) => {
    const range = locateText(doc, rewrite.find)
    return range && inScope(range, scope)
      ? [{ ...rewrite, at: range.from }]
      : []
  }).sort((a, b) => a.at - b.at)
  const cut = found.reduce(
    (total, rewrite) =>
      total + countWords(rewrite.find) - countWords(rewrite.replace),
    0
  )
  const read = scope
    ? "Read the selection"
    : `Read ${plural(sectionCount(doc), "section")}`
  if (found.length === 0) {
    return {
      steps: [read, "Looked for filler"],
      edits: [],
      summary: NO_SUMMARY,
      answer: {
        title: "Nothing to tighten",
        findings: [],
        note: scope
          ? "The selection is already lean."
          : "Every paragraph is already lean.",
      },
    }
  }
  return {
    steps: [
      read,
      `Found ${plural(found.length, "wordy passage")}`,
      `Cutting ${plural(cut, "word")}`,
    ],
    edits: found.map((rewrite) => ({
      kind: "replace",
      find: rewrite.find,
      whole: false,
      text: rewrite.replace,
      at: rewrite.at,
    })),
    summary: {
      title: "Wording tightened",
      detail: `${plural(cut, "word")} fewer`,
    },
  }
}

// Text the agent inserted that nobody has accepted yet.
function isPending(doc: ProseMirrorNode, range: TextRange) {
  const node = doc.nodeAt(range.from)
  return Boolean(
    node?.marks.some((mark) => mark.type.name === SUGGESTION_INSERT)
  )
}

type BlockState = "missing" | "pending" | "present"

function summaryState(doc: ProseMirrorNode): BlockState {
  const range = locateText(doc, ASSIST_SUMMARY.label)
  if (!range) return "missing"
  return isPending(doc, range) ? "pending" : "present"
}

/** Which launch tasks the plan lacks, judged by content, not the heading. */
function checklistState(doc: ProseMirrorNode) {
  const { heading, items } = ASSIST_CHECKLIST
  const headingRange = locateText(doc, heading)
  const found = items.map((item) => ({ item, range: locateText(doc, item) }))
  const ranges = [headingRange, ...found.map(({ range }) => range)]
  return {
    pending: ranges.some((range) => range !== null && isPending(doc, range)),
    missing: found.filter(({ range }) => !range).map(({ item }) => item),
    hasHeading: headingRange !== null,
    listWith: found.find(({ range }) => range)?.item ?? null,
  }
}

function planSummary(doc: ProseMirrorNode): AssistPlan {
  const state = summaryState(doc)
  if (state !== "missing") {
    return {
      steps: ["Read the opening"],
      edits: [],
      summary: NO_SUMMARY,
      answer:
        state === "pending"
          ? {
              title: "Summary in review",
              findings: [],
              note: "Accept or reject the suggested summary first.",
            }
          : {
              title: "Summary already there",
              findings: [],
              note: "The plan opens with a summary, so nothing was added.",
            },
    }
  }
  return {
    steps: [
      `Read ${plural(sectionCount(doc), "section")}`,
      "Picked dates, gates and order",
      "Writing the summary",
    ],
    edits: [{ kind: "summary", ...ASSIST_SUMMARY }],
    summary: { title: "Summary added", detail: "Under the title" },
  }
}

function planChecklist(doc: ProseMirrorNode): AssistPlan {
  const { heading, before, items } = ASSIST_CHECKLIST
  const { pending, missing, hasHeading, listWith } = checklistState(doc)
  if (pending || missing.length === 0) {
    return {
      steps: ["Read the plan"],
      edits: [],
      summary: NO_SUMMARY,
      answer: pending
        ? {
            title: "Checklist in review",
            findings: [],
            note: "Accept or reject the suggested to-dos first.",
          }
        : {
            title: "Checklist already there",
            findings: [],
            note: "Every launch to-do is in the plan already.",
          },
    }
  }
  const partial = missing.length < items.length || hasHeading
  return {
    steps: [
      "Read Stages and Risks",
      `Found ${plural(missing.length, "to-do")}`,
      partial ? "Adding the missing to-dos" : "Adding the checklist",
    ],
    edits: [
      {
        kind: "checklist",
        heading,
        addHeading: !hasHeading && listWith === null,
        before,
        items: missing,
        listWith,
      },
    ],
    summary: { title: partial ? "To-dos added" : "Checklist added" },
  }
}

/** Sentences ending in a question mark or carrying TBD. */
function planQuestions(
  doc: ProseMirrorNode,
  scope: AssistScope | null
): AssistPlan {
  const findings: AssistFinding[] = []
  let section = ""
  for (const block of readBlocks(doc)) {
    if (block.node.type.name === "heading") {
      section = block.text
      continue
    }
    for (const match of block.text.matchAll(/[^.?!]+[.?!]+/g)) {
      const sentence = match[0].trim()
      if (!/\?$|\bTBD\b/.test(sentence)) continue
      const start = match.index + match[0].indexOf(sentence)
      if (!inScope(rangeOf(block, start, sentence.length), scope)) continue
      findings.push({
        id: `q-${findings.length}`,
        text: sentence,
        section,
        find: sentence,
      })
    }
  }
  return {
    steps: [
      scope
        ? "Read the selection"
        : `Read ${plural(sectionCount(doc), "section")}`,
      `Found ${plural(findings.length, "open question")}`,
    ],
    edits: [],
    summary: NO_SUMMARY,
    answer: {
      title:
        findings.length === 0
          ? "No open questions"
          : plural(findings.length, "open question"),
      findings,
      note:
        findings.length === 0
          ? "Every item has an answer and an owner."
          : undefined,
    },
  }
}

/** Task items that name a teammate; the name is trimmed off the task. */
function planOwners(doc: ProseMirrorNode): AssistPlan {
  const findings: AssistFinding[] = []
  doc.descendants((node) => {
    if (node.type.name !== "taskItem") return true
    const text = node.textContent
    const person = PEOPLE.find((candidate) => text.includes(candidate.name))
    if (person) {
      findings.push({
        id: `o-${findings.length}`,
        text: text.replace(`, ${person.name}`, "").replace(person.name, ""),
        section: person.name,
        find: text,
        person: person.id,
        done: node.attrs.checked === true,
      })
    }
    return false
  })
  const open = findings.filter((finding) => !finding.done).length
  return {
    steps: ["Read Sign-off", `Matched ${plural(findings.length, "owner")}`],
    edits: [],
    summary: NO_SUMMARY,
    answer: {
      title:
        findings.length === 0
          ? "No owners named"
          : `${plural(findings.length, "owner")}, ${open ? `${open} open` : "all signed"}`,
      findings,
      note:
        findings.length === 0
          ? "No task in the plan names a teammate yet."
          : undefined,
    },
  }
}

/** customize: swap these planners for your model's tool calls. */
export function planAction(
  id: AssistActionId,
  doc: ProseMirrorNode,
  scope: AssistScope | null
): AssistPlan {
  switch (id) {
    case "proofread":
      return planProofread(doc, scope)
    case "tighten":
      return planTighten(doc, scope)
    case "summary":
      return planSummary(doc)
    case "checklist":
      return planChecklist(doc)
    case "questions":
      return planQuestions(doc, scope)
    case "owners":
      return planOwners(doc)
  }
}

/** Maps a typed ask to an action; null means the agent asks back. */
export function matchAction(prompt: string): AssistActionId | null {
  return (
    ASSIST_ACTIONS.find((action) => action.keywords.test(prompt))?.id ?? null
  )
}

const BLOCK_READOUT: Record<BlockState, string> = {
  missing: "None yet",
  pending: "In review",
  present: "Added",
}

/** One live fact per task from the plans a run follows, so no row
 * over-promises; it stays local, with no model call on open. */
export function previewReadouts(
  doc: ProseMirrorNode,
  scope: AssistScope | null
): Record<AssistActionId, string> {
  const typos = planProofread(doc, scope).edits.length
  const passages = planTighten(doc, scope).edits.length
  const questions = planQuestions(doc, scope).answer?.findings.length ?? 0
  const owners = planOwners(doc).answer?.findings ?? []
  const open = owners.filter((owner) => !owner.done).length
  const checklist = checklistState(doc)
  return {
    proofread: typos ? plural(typos, "typo") : "All clear",
    tighten: passages ? plural(passages, "passage") : "All clear",
    summary: BLOCK_READOUT[summaryState(doc)],
    checklist: checklist.pending
      ? "In review"
      : checklist.missing.length
        ? plural(checklist.missing.length, "to-do")
        : "Added",
    questions: questions ? `${questions} found` : "All clear",
    owners:
      owners.length === 0 ? "None named" : open ? `${open} open` : "All signed",
  }
}

/** Words a reader sees inside the selection; struck text is left out. */
export function selectionWords(doc: ProseMirrorNode, scope: AssistScope) {
  let text = ""
  for (const block of readBlocks(doc)) {
    for (const [index, char] of [...block.text].entries()) {
      const pos = block.map[index] ?? -1
      if (pos >= scope.from && pos < scope.to) text += char
    }
    text += " "
  }
  return countWords(text)
}

/** The first planned replace, where a run starts searching. */
export function firstReplaceAt(edits: AssistEdit[]) {
  const starts = edits.flatMap((edit) =>
    edit.kind === "replace" ? [edit.at] : []
  )
  return starts.length ? Math.min(...starts) : 0
}