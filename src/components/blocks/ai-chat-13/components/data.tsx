import type { ReactNode } from "react"
import { ActivityIcon, TriangleAlertIcon, BookOpenIcon, RocketIcon } from "lucide-react"

export const ORG_NAME = "Halcyon Labs"
export const PAGE_NAME = "API Health"
export const ASSISTANT_NAME = "ReUI Chat"
export const LAUNCHER_LABEL = "Ask AI"
export const COMPOSER_PLACEHOLDER = "Ask about this page"
export const FOOTNOTE = "Replies can be wrong. Check before acting."

export type PersonRecord = {
  name: string
  email: string
  initials: string
  avatar: string
}

/** The person the greeting is written for and the account menu belongs to. */
export const VIEWER: PersonRecord = {
  name: "Maya Chen",
  email: "maya@halcyonlabs.io",
  initials: "MC",
  avatar:
    "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=96&h=96&dpr=2&q=80",
}

export type OrganizationRecord = {
  id: string
  name: string
  /** The plan line under the name. */
  tier: string
  /** Stops for the round gradient mark; swap the mark for a real logo. */
  gradient: [string, string, string]
}

// customize: the organizations the viewer belongs to. The first is open on
// load, and the page header names whichever one is picked.
export const ORGANIZATIONS: OrganizationRecord[] = [
  {
    id: "halcyon",
    name: ORG_NAME,
    tier: "Enterprise",
    gradient: ["#6366f1", "#8b5cf6", "#ec4899"],
  },
  {
    id: "halcyon-research",
    name: "Halcyon Research",
    tier: "Pro",
    gradient: ["#0ea5e9", "#06b6d4", "#10b981"],
  },
  {
    id: "kestrel",
    name: "Kestrel Ops",
    tier: "Team",
    gradient: ["#f97316", "#f59e0b", "#84cc16"],
  },
]

export const GREETING = {
  title: `Hi ${VIEWER.name.split(" ")[0]}`,
  lead: `I read ${PAGE_NAME} and anything you attach.`,
}

export type SourceRecord = {
  id: string
  /** The short name a chip and a menu row carry. */
  chip: string
  hint: string
  icon: ReactNode
}

// customize: what the assistant may read. The page is attached on open; the
// plus menu in the composer adds or drops the rest.
export const SOURCES: SourceRecord[] = [
  {
    id: "page",
    chip: PAGE_NAME,
    hint: "The page you have open",
    icon: (
      <ActivityIcon aria-hidden="true" />
    ),
  },
  {
    id: "incident",
    chip: "INC-2291",
    hint: "Slow audit exports on eu-west",
    icon: (
      <TriangleAlertIcon aria-hidden="true" />
    ),
  },
  {
    id: "runbook",
    chip: "Replica Runbook",
    hint: "Index and failover steps",
    icon: (
      <BookOpenIcon aria-hidden="true" />
    ),
  },
  {
    id: "release",
    chip: "Release 3.4",
    hint: "Shipped Thursday, Sep 17",
    icon: (
      <RocketIcon aria-hidden="true" />
    ),
  },
]

export const DEFAULT_SOURCES = ["page"]

/** Starter rows on a fresh chat. Each one sends as typed. */
export const STARTERS = [
  "Why did p95 double on eu-west?",
  "Which endpoints fail the most?",
  "How do we fix the slowdown?",
  "Draft a status update for customers",
  "What changed in release 3.4?",
]

export type TableColumn = {
  key: string
  label: string
  /** End aligned in tabular figures; cellText adds the unit. */
  numeric?: boolean
  unit?: string
  /** Summed into the footer's Total row. */
  total?: boolean
  /** Endpoints and other identifiers, set in mono. */
  mono?: boolean
  /** Renders the cell through STATUS_BADGE instead of as plain text. */
  badge?: boolean
}

export type AnswerTable = {
  /** Read to a screen reader; on screen the lead already says it. */
  caption: string
  columns: TableColumn[]
  rows: Record<string, string | number>[]
}

export type FigureRecord = { value: string; label: string }

/** The one state face a table cell can carry. */
export const STATUS_BADGE: Record<
  string,
  {
    variant: "warning-light" | "success-light" | "destructive-light" | "outline"
    label: string
  }
> = {
  missing: { variant: "warning-light", label: "Missing" },
  built: { variant: "success-light", label: "Built" },
  "504": { variant: "destructive-light", label: "504" },
  "500": { variant: "destructive-light", label: "500" },
  "401": { variant: "outline", label: "401" },
}

/** Answers carry `code` and **bold** inline; the view renders both. */
export type AnswerBody = {
  lead: string
  /** The numbers the answer rests on, in a row under the lead. */
  figures?: FigureRecord[]
  table?: AnswerTable
  points?: string[]
  /** Ordered actions, numbered in the view. */
  steps?: string[]
  code?: { language: string; filename: string; code: string }
  /** Text written for the reader to paste elsewhere, set apart from the prose. */
  draft?: { title: string; text: string }
  /** The one caveat or all clear that must not read as prose. */
  callout?: { tone: "warning" | "success"; title: string; detail: string }
  note?: string
  /** The next question, offered under the answer once it settles. */
  followUps?: string[]
}

export type Vote = "up" | "down"

export type TurnRecord =
  | {
      id: string
      kind: "asked"
      text: string
      /** SOURCES ids attached at send time, shown under the question. */
      sources: string[]
      /** Set when Stop dropped the reply this question was waiting on. */
      stopped?: boolean
    }
  | ({
      id: string
      kind: "answer"
      /** The reader's rating, set from the thumbs under the answer. */
      vote?: Vote
    } & AnswerBody)

export type ThreadRecord = {
  id: string
  /** Fixed label: a relative time needs a clock the demo does not have. */
  at: string
  /** The History section the chat is filed under. */
  recency: "today" | "yesterday" | "earlier"
  /** Starred from the header, which files the chat under Pinned. */
  pinned?: boolean
  turns: TurnRecord[]
}

/** A thread is named by its first question, so the history reads as asked. */
export function threadTitle(thread: ThreadRecord) {
  const first = thread.turns.find((turn) => turn.kind === "asked")
  return first?.kind === "asked" ? first.text : "New Chat"
}

/** Numbers are stored raw so a footer can total them; the comma arrives here. */
export function cellText(value: string | number, column: TableColumn) {
  if (column.badge) return STATUS_BADGE[String(value)]?.label ?? String(value)
  const text = typeof value === "number" ? value.toLocaleString("en-US") : value
  return column.unit ? `${text} ${column.unit}` : text
}

export function columnTotal(table: AnswerTable, key: string) {
  return table.rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0)
}

/** Tab separated, so a pasted table lands in a spreadsheet as columns. */
function tableText(table: AnswerTable) {
  const lines = [
    table.columns.map((column) => column.label),
    ...table.rows.map((row) =>
      table.columns.map((column) => cellText(row[column.key], column))
    ),
  ]
  if (table.columns.some((column) => column.total))
    lines.push(
      table.columns.map((column, index) =>
        index === 0
          ? "Total"
          : column.total
            ? cellText(columnTotal(table, column.key), column)
            : ""
      )
    )
  return lines.map((cells) => cells.join("\t")).join("\n")
}

/** Plain text for the clipboard, in the order the answer reads: one blank line
    between parts, code fenced so it pastes into a chat as code. */
export function answerText(turn: AnswerBody) {
  return [
    turn.lead,
    turn.figures
      ?.map((figure) => `${figure.label}: ${figure.value}`)
      .join("\n"),
    turn.table ? tableText(turn.table) : undefined,
    turn.points?.map((point) => `- ${point}`).join("\n"),
    turn.steps?.map((step, index) => `${index + 1}. ${step}`).join("\n"),
    turn.code
      ? `\`\`\`${turn.code.language}\n${turn.code.code}\n\`\`\``
      : undefined,
    turn.draft?.text,
    turn.callout ? `${turn.callout.title}: ${turn.callout.detail}` : undefined,
    turn.note,
  ]
    .filter(Boolean)
    .join("\n\n")
}

const LATENCY_ANSWER: AnswerBody = {
  lead: "All of the rise is in `GET /v1/audit-events`, and only eu-west slowed down.",
  table: {
    caption: "p95 latency by region, 13:50 and 14:10",
    columns: [
      { key: "region", label: "Region" },
      { key: "before", label: "13:50", numeric: true, unit: "ms" },
      { key: "after", label: "14:10", numeric: true, unit: "ms" },
      { key: "index", label: "Index", badge: true },
    ],
    rows: [
      { region: "eu-west", before: 190, after: 405, index: "missing" },
      { region: "us-east", before: 186, after: 188, index: "built" },
    ],
  },
  points: [
    "`events_workspace_created_idx` exists on us-east but was never built on the eu-west cluster.",
    "Without it each export scans about **2.4M rows** instead of reading the index.",
  ],
  note: "Thursday's release did not touch this table, so a rollback would not help.",
  followUps: ["How do we fix the slowdown?", "Which accounts are affected?"],
}

const ERRORS_ANSWER: AnswerBody = {
  lead: "1,714 failed requests in the last 24 hours, and three endpoints account for every one of them.",
  table: {
    caption: "Failed requests by endpoint, last 24 hours",
    columns: [
      { key: "endpoint", label: "Endpoint", mono: true },
      { key: "errors", label: "Errors", numeric: true, total: true },
      { key: "status", label: "Status", badge: true },
    ],
    rows: [
      { endpoint: "GET /v1/audit-events", errors: 1284, status: "504" },
      { endpoint: "POST /v1/exports", errors: 312, status: "500" },
      { endpoint: "POST /v1/webhooks/test", errors: 118, status: "401" },
    ],
  },
  note: "The 504s and 500s share the missing index on eu-west, and exports retry on their own. The 401s come from one customer's misconfigured key.",
  followUps: ["Why did p95 double on eu-west?"],
}

const FIX_ANSWER: AnswerBody = {
  lead: "Build the missing index on the eu-west cluster with `create index concurrently`, so writes keep flowing while it runs.",
  steps: [
    "Open step 4 of the replica runbook and confirm the session is on eu-west.",
    "Run the statement below on the primary.",
    "Give the build about 20 minutes to finish.",
    // The no break space keeps the unit on the number's line.
    "Watch the p95 chart settle back near 190\u00a0ms.",
  ],
  code: {
    language: "sql",
    filename: "eu-west.sql",
    code: "create index concurrently\n  events_workspace_created_idx\n  on events\n  (workspace_id, created_at desc);",
  },
  callout: {
    tone: "warning",
    title: "If It Fails",
    detail:
      "A failed `concurrently` build leaves an invalid index behind. Drop it before you retry, or every write keeps paying for it.",
  },
  followUps: ["Draft a status update for customers"],
}

const AFFECTED_ANSWER: AnswerBody = {
  lead: "Every workspace routed to eu-west sees slow audit exports, and nothing else is affected.",
  figures: [
    { value: "38", label: "Workspaces" },
    { value: "1,284", label: "Audit event timeouts" },
    { value: "405\u00a0ms", label: "p95 now" },
  ],
  note: "Berlin routes there, so that account feels it on every export. us-east has the index and is unaffected.",
  followUps: ["Draft a status update for customers"],
}

const STATUS_ANSWER: AnswerBody = {
  lead: "Here is a draft for the status page.",
  draft: {
    title: "Status Update",
    text: "Investigating: some API requests in eu-west have been slower than usual since 13:50 UTC. Audit event exports are the most affected; other endpoints and regions are normal. We have found the cause and expect a fix within the hour.",
  },
  note: "Nothing is posted from here. Edit it, then publish it yourself.",
}

const RELEASE_ANSWER: AnswerBody = {
  lead: "Three admin-facing changes shipped in 3.4.",
  points: [
    "**SCIM group sync** runs every 15 minutes instead of hourly.",
    "**Audit log export** accepts a date range.",
    "**Session timeout** is set per workspace rather than per org.",
  ],
  callout: {
    tone: "success",
    title: "Not the Cause",
    detail:
      "None of them sit in the request path or touch `events_workspace_created_idx`, so rolling back 3.4 would not help.",
  },
  followUps: ["Why did p95 double on eu-west?"],
}

/** Sent with nothing attached: say so instead of answering from nowhere. */
const NO_SOURCES_ANSWER: AnswerBody = {
  lead: `Nothing is attached, so I can only search the workspace index. Add ${PAGE_NAME} with the plus button for numbers from this page.`,
}

const FALLBACK_ANSWERS: AnswerBody[] = [
  {
    lead: `I could not match that to ${PAGE_NAME} or the attached sources. Try naming an endpoint, a region or a time window.`,
  },
  {
    lead: "That is outside what I can see here. Ask about latency, errors or the 3.4 release and I can answer from the page.",
  },
]

// customize: keyword routing stands in for your model call. The first entry
// with a matching word wins, so keep the narrow ones on top.
const REPLY_LIBRARY: { match: string[]; body: AnswerBody }[] = [
  { match: ["affected", "accounts", "who"], body: AFFECTED_ANSWER },
  { match: ["status", "draft", "announce"], body: STATUS_ANSWER },
  { match: ["fix", "index", "resolve"], body: FIX_ANSWER },
  { match: ["endpoint", "error", "fail", "5xx"], body: ERRORS_ANSWER },
  { match: ["p95", "latency", "slow", "eu-west"], body: LATENCY_ANSWER },
  { match: ["3.4", "release", "changed", "shipped"], body: RELEASE_ANSWER },
]

/** replyIndex counts replies in the session, so the fallback lines take turns. */
export function composeReply(
  prompt: string,
  sources: string[],
  replyIndex: number
) {
  if (sources.length === 0) return NO_SOURCES_ANSWER
  const text = prompt.toLowerCase()
  const entry = REPLY_LIBRARY.find((candidate) =>
    candidate.match.some((word) => text.includes(word))
  )
  return entry?.body ?? FALLBACK_ANSWERS[replyIndex % FALLBACK_ANSWERS.length]
}

/** The line the thinking marker shows, named after what is being read. */
export function readingLabel(sources: string[]) {
  const first = SOURCES.find((source) => sources.includes(source.id))
  return first ? `Reading ${first.chip}` : "Searching the workspace"
}

export const NEW_THREAD_ID = "th_new"

// customize: the signed in user's earlier conversations, newest first.
export const THREADS: ThreadRecord[] = [
  { id: NEW_THREAD_ID, at: "Now", recency: "today", turns: [] },
  {
    id: "th_4be7d2",
    at: "09:42",
    recency: "today",
    turns: [
      {
        id: "t_4be7d2_1",
        kind: "asked",
        text: "Which endpoints fail most this week?",
        sources: ["page"],
      },
      {
        id: "t_4be7d2_2",
        kind: "answer",
        lead: "`POST /v1/exports` leads with 312 server errors, then `GET /v1/events` with 88.",
        points: [
          "Export errors retry on their own, so no export was lost.",
          "The events errors are 429s from two workspaces over their burst limit.",
        ],
      },
    ],
  },
  {
    id: "th_7f21c4",
    at: "Yesterday",
    recency: "yesterday",
    turns: [
      {
        id: "t_7f21c4_1",
        kind: "asked",
        text: "Why are staging webhooks retrying?",
        sources: ["runbook"],
      },
      {
        id: "t_7f21c4_2",
        kind: "answer",
        lead: "Staging returns 503 while its deploy rolls, so each delivery retries with backoff until the pods report ready.",
        note: "Nothing was lost: 46 deliveries replayed on their own after 10:12.",
      },
    ],
  },
  {
    id: "th_31a9e0",
    at: "Mon",
    recency: "earlier",
    pinned: true,
    turns: [
      {
        id: "t_31a9e0_1",
        kind: "asked",
        text: "How close are we to the monthly request cap?",
        sources: ["page"],
      },
      {
        id: "t_31a9e0_2",
        kind: "answer",
        lead: "41.2M of the 50M requests in this month's plan are used, about 82%.",
        points: [
          "At the current pace the cap arrives on Sep 26, four days early.",
          "Burst credits cover roughly 3M more before requests throttle.",
        ],
      },
    ],
  },
  {
    id: "th_c58b12",
    at: "Sep 18",
    recency: "earlier",
    turns: [
      {
        id: "t_c58b12_1",
        kind: "asked",
        text: "Can audit exports take a date range now?",
        sources: ["release"],
      },
      {
        id: "t_c58b12_2",
        kind: "answer",
        lead: "Yes. Since 3.4 an audit log export takes a start and end date, up to 400 days back.",
        steps: [
          "Open Settings, then Audit log.",
          "Pick the range and choose Export.",
          "Large ranges finish in the background and email a download link.",
        ],
      },
    ],
  },
  {
    id: "th_9d03f7",
    at: "Sep 12",
    recency: "earlier",
    turns: [
      {
        id: "t_9d03f7_1",
        kind: "asked",
        text: "How do I rotate the staging API key?",
        sources: ["runbook"],
      },
      {
        id: "t_9d03f7_2",
        kind: "answer",
        lead: "Create the new key first, then retire the old one, so staging never runs without a key.",
        steps: [
          "Open Settings, then API keys, and create a staging key.",
          "Put the new key in the staging deploy secrets and redeploy.",
          "Revoke the old key once requests with it drop to zero.",
        ],
      },
    ],
  },
]