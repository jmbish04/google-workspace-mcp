import type { ReactNode } from "react"
import type { JSONContent } from "@tiptap/react"
import { SUGGESTION_DELETE, SUGGESTION_INSERT } from "./rich-text-changes"
import { CheckCheckIcon, Minimize2Icon, TextQuoteIcon, ListChecksIcon, CircleHelpIcon, UsersIcon } from "lucide-react"

export type PersonId = "maya" | "daniel" | "lena" | "arjun"

export type Access = "Owner" | "Can edit" | "Can comment"

export interface Person {
  id: PersonId
  name: string
  initials: string
  role: string
  avatar: string
  access: Access
}

export const PEOPLE: Person[] = [
  {
    id: "lena",
    name: "Lena Hoffmann",
    avatar:
      "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=96&h=96&dpr=2&q=80",
    initials: "LH",
    role: "Engineering manager, search",
    access: "Owner",
  },
  {
    id: "daniel",
    name: "Daniel Okafor",
    avatar:
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=96&h=96&dpr=2&q=80",
    initials: "DO",
    role: "Support operations manager",
    access: "Can edit",
  },
  {
    id: "maya",
    name: "Maya Chen",
    avatar:
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=96&h=96&dpr=2&q=80",
    initials: "MC",
    role: "Product marketing lead",
    access: "Can comment",
  },
  {
    id: "arjun",
    name: "Arjun Mehta",
    avatar:
      "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=96&h=96&dpr=2&q=80",
    initials: "AM",
    role: "Product designer",
    access: "Can edit",
  },
]

/** The agent: its id stamps every suggestion it writes. */
export const AGENT = { id: "assist", name: "Assist" } as const

const DEMO_NOW = "2026-09-26T15:00:00.000Z"

/** The one clock; customize: return the real time as an ISO string. */
export function currentTime() {
  return DEMO_NOW
}

export const DOC_META = {
  title: "Inbox Search Rollout",
  kind: "Rollout plan",
  ownerId: "lena" satisfies PersonId,
  editedAt: "2026-09-26",
  shareUrl: "https://docs.loomwell.example/d/inbox-search-rollout",
}

export interface Rewrite {
  /** Exact text the agent looks for; an edited passage is skipped. */
  find: string
  replace: string
}

const INTRO_REWRITE: Rewrite = {
  find: "At this point in time, the plan is to roll out the new inbox search to every workspace in a number of stages, in order to make sure that we are able to catch regressions well before they have a chance to reach our largest customers.",
  replace:
    "We will release inbox search in four stages, so regressions surface before they reach our largest customers.",
}

const METRICS_REWRITE: Rewrite = {
  find: "It is important to note that a stage can only move forward when all of the numbers below have held steady for a period of three consecutive days.",
  replace:
    "A stage moves forward only after these numbers hold for three straight days.",
}

/** customize: the tighten pass's rewrites; a real agent returns these. */
export const ASSIST_REWRITES: Rewrite[] = [INTRO_REWRITE, METRICS_REWRITE]

/** customize: the spelling pass's dictionary, matched as whole words. */
export const ASSIST_MISSPELLINGS: Record<string, string> = {
  recieve: "receive",
  seperate: "separate",
  occured: "occurred",
  definately: "definitely",
  untill: "until",
  accomodate: "accommodate",
  enviroment: "environment",
  begining: "beginning",
  calender: "calendar",
  tommorow: "tomorrow",
  thier: "their",
  wich: "which",
}

export const ASSIST_SUMMARY = {
  label: "In short:",
  text: "Inbox search reaches every workspace on October 14 after internal and beta stages, gated on query speed, zero result rate and ticket volume. Enterprise follows a week later.",
}

export const ASSIST_CHECKLIST = {
  heading: "Launch checklist",
  /** The section the checklist lands above; the end of the plan otherwise. */
  before: "Sign-off",
  items: [
    "Publish the inbox search help article",
    "Add the search feedback macro to support",
    "Turn on the search quality dashboard",
    "Book the enterprise index rebuild windows",
  ],
}

export type AssistActionId =
  "proofread" | "tighten" | "summary" | "checklist" | "questions" | "owners"

export type AssistGroup = "Edit" | "Add" | "Review"

export interface AssistAction {
  id: AssistActionId
  label: string
  group: AssistGroup
  /** Edit and Review follow a selection; Add always places its own block. */
  scoped: boolean
  /** A typed ask that matches runs this action. */
  keywords: RegExp
  icon: ReactNode
}

export const ASSIST_ACTIONS: AssistAction[] = [
  {
    id: "proofread",
    label: "Fix Spelling",
    group: "Edit",
    scoped: true,
    keywords: /spell|typo|proof|grammar|mistake/i,
    icon: (
      <CheckCheckIcon aria-hidden="true" />
    ),
  },
  {
    id: "tighten",
    label: "Tighten Wording",
    group: "Edit",
    scoped: true,
    keywords: /short|tight|concise|\btrim|wordy|\bcut\b/i,
    icon: (
      <Minimize2Icon aria-hidden="true" />
    ),
  },
  {
    id: "summary",
    label: "Write Summary",
    group: "Add",
    scoped: false,
    keywords: /summar|tl;?dr|overview|recap/i,
    icon: (
      <TextQuoteIcon aria-hidden="true" />
    ),
  },
  {
    id: "checklist",
    label: "Add Checklist",
    group: "Add",
    scoped: false,
    keywords: /check ?list|to-?do|tasks|action items/i,
    icon: (
      <ListChecksIcon aria-hidden="true" />
    ),
  },
  {
    id: "questions",
    label: "Open Questions",
    group: "Review",
    scoped: true,
    keywords: /question|\bopen\b|\btbd\b|missing|unclear/i,
    icon: (
      <CircleHelpIcon aria-hidden="true" />
    ),
  },
  {
    id: "owners",
    label: "List Owners",
    group: "Review",
    scoped: false,
    keywords: /owner|\bwho\b|assign|responsib|sign[- ]?off/i,
    icon: (
      <UsersIcon aria-hidden="true" />
    ),
  },
]

export const ASSIST_GROUPS: AssistGroup[] = ["Edit", "Add", "Review"]

type Mark = NonNullable<JSONContent["marks"]>[number]

// One pending run from Assist: two rewrites and a spelling fix.
const SEEDED_SUGGESTIONS = {
  intro: { id: "s-intro", author: AGENT.id, time: "2026-09-26T14:58:00.000Z" },
  beta: { id: "s-beta", author: AGENT.id, time: "2026-09-26T14:58:00.000Z" },
  metrics: {
    id: "s-metrics",
    author: AGENT.id,
    time: "2026-09-26T14:58:00.000Z",
  },
}

type SeededId = keyof typeof SEEDED_SUGGESTIONS

function text(value: string, ...marks: Mark[]): JSONContent {
  return marks.length
    ? { type: "text", text: value, marks }
    : { type: "text", text: value }
}

const bold: Mark = { type: "bold" }

function inserted(id: SeededId): Mark {
  return { type: SUGGESTION_INSERT, attrs: SEEDED_SUGGESTIONS[id] }
}

function deleted(id: SeededId): Mark {
  return { type: SUGGESTION_DELETE, attrs: SEEDED_SUGGESTIONS[id] }
}

function paragraph(...content: JSONContent[]): JSONContent {
  return { type: "paragraph", content }
}

function heading(level: 1 | 2, value: string): JSONContent {
  return { type: "heading", attrs: { level }, content: [text(value)] }
}

function item(...content: JSONContent[]): JSONContent {
  return { type: "listItem", content: [paragraph(...content)] }
}

function task(checked: boolean, value: string): JSONContent {
  return {
    type: "taskItem",
    attrs: { checked },
    content: [paragraph(text(value))],
  }
}

// Seeded marks load with the document, so no transaction runs at mount.
export const DOCUMENT: JSONContent = {
  type: "doc",
  content: [
    heading(1, DOC_META.title),
    paragraph(
      text(INTRO_REWRITE.find, deleted("intro")),
      text(INTRO_REWRITE.replace, inserted("intro"))
    ),
    paragraph(
      text(
        "Search ships with Loomwell 4.2 on October 14. This plan covers each stage, the metrics that gate it and who signs off."
      )
    ),
    heading(2, "Stages"),
    {
      type: "orderedList",
      content: [
        item(
          text("Internal", bold),
          text(": the Kestrel Works support team, from September 29.")
        ),
        item(
          text("Beta", bold),
          text(": 40 opt-in workspaces, from October 6. Beta admins will "),
          text("recieve", deleted("beta")),
          text("receive", inserted("beta")),
          text(" a short survey after their first week.")
        ),
        item(
          text("General availability", bold),
          text(": every workspace on October 14.")
        ),
        item(
          text("Enterprise", bold),
          text(": workspaces over 500 seats, one week after GA.")
        ),
      ],
    },
    heading(2, "Success metrics"),
    paragraph(
      text(METRICS_REWRITE.find, deleted("metrics")),
      text(METRICS_REWRITE.replace, inserted("metrics"))
    ),
    {
      type: "bulletList",
      content: [
        item(text("Median query time under 300 ms, p95 under 900 ms.")),
        item(text("Zero result rate below 8 percent on the top 200 queries.")),
        item(text("No rise in tickets tagged search against the prior week.")),
      ],
    },
    paragraph(
      text(
        "Any stage pauses on its own if a rollback has occured in the last 24 hours."
      )
    ),
    heading(2, "Risks"),
    paragraph(
      text(
        "Index rebuilds for the largest workspaces take up to 6 hours, so enterprise accounts move last. The rebuild runbook still needs an owner (TBD)."
      )
    ),
    paragraph(
      text(
        "Support needs a seperate macro for search feedback before beta starts. Who writes the macro copy, Daniel or Maya?"
      )
    ),
    heading(2, "Sign-off"),
    {
      type: "taskList",
      content: [
        task(true, "Search quality review, Lena Hoffmann"),
        task(false, "Support readiness, Daniel Okafor"),
        task(false, "Launch messaging, Maya Chen"),
        task(false, "Result card design QA, Arjun Mehta"),
      ],
    },
  ],
}

/** The run behind the seeded suggestions, so the dock opens on its review. */
export const SEEDED_RUN = { summary: { title: "Plan polished" } }