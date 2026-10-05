# Combined Email Rich-Text Editor — Plan

**Status:** paused (token budget). **Maestro:** project `google-workspace-mcp` ·
plan `feb8a26602a5` → "Phase 6 — Draft studio integration" · epic
`epic-draft-ux` (Device-Optimized Draft Studio & Review UX) · parent task
`a6419d1880f9` · children `CEE-1..10` (IDs in the table below).

## The goal, in one line

One rich-text editor for email drafts in the Draft Studio that merges the useful
parts of ReUI blocks RTE1 + RTE2 + RTE3 + RTE5, with an **ai-chat-13** chat
window as the assistant — where the agent proposes **bulk, sentence-level edits
as accept/reject suggestions**, never silent overwrites.

## What each block contributes

| Block | Features pulled in |
|---|---|
| **RTE1** | formatting toolbar, link bubble, task-list checkboxes, **word + char count** (char count matters for length-capped emails) |
| **RTE2** | slash commands, **@mentions**, **resizable tables**, outline rail |
| **RTE3** | suggesting mode (both directions), accept/reject **cards**, **final-vs-original** preview, sticky review margin, change navigator |
| **RTE5** | streamed suggestions, step trace, review dock — mechanics only |
| **ai-chat-13** | the assistant surface (a real chat window) **instead of** RTE5's background-blur dock, so the **full document stays visible** |

## Decisions (settled)

- **RTE4 / Yjs live collaboration: dropped.** The agent makes bulk
  sentence/paragraph edits as suggestions; there is nothing to watch
  keystroke-by-keystroke. A re-read-on-change cue covers it. No CRDT.
- **Assistant = ai-chat-13**, not RTE5's blur dock — full doc visible.
- **"Context composer"** (the one open question): resolved. It's RTE5's
  `AssistComposer` — the input where you write the request **and** choose its
  scope (whole document vs current selection) plus a task menu. No longer needs
  asking.
- **Model selection = Core Guardian by `use_case`**, never a pinned model.
  Guardian picks the best cost-effective model at call time
  (`/api/ai-router/use-cases`; only `project` + `importance` are required).
- **Suggesting is bidirectional:** you can suggest edits, or ask the AI to
  review what you have (`/review`) and propose.

## Non-negotiables

- ReUI blocks used **as shipped**; editor islands mount `client:only="react"`.
- Agent edits are **suggestions** (RTE3 accept/reject), never a silent overwrite.
- The email body always goes out through `backend/gmail/compose.ts` (the Gmail
  HTML standard `fc8124b830f8` owns the wire format).
- Model calls go through **Core Guardian** (`guardianRun`).
- Tests are **seen-to-fail** — no fixture that was green before the code existed.

## Architecture

- A new `email-editor/` composition is the heart of `/gws/draft-studio/[id]`.
- **The hard part (CEE-1):** RTE1/2/3/5 each ship their *own* copy of the
  `rich-text-*` extension modules. Combining them is a real merge of extension
  sets — base on RTE2 (richest editing surface) + layer RTE3's `RichTextChanges`
  suggestion engine + RTE1 counts, deduping any duplicate extension names (Tiptap
  throws on duplicates). This is the foundation everything else builds on.
- Backend `POST /api/email-drafts/:id/suggest` runs the model through Core
  Guardian by use-case and returns bulk edits the editor streams in as tracked
  suggestions. Accept commits a normal revision via `POST /:id/revisions`.
- Full draft **CRUD over MCP** (Justin mostly drives this via the MCP tool):
  `create/update/get/list/send` exist; **`discard`/delete is missing** and the
  suggest/review action should be exposed over MCP too.

## Current state (2026-10-05)

- **DONE + deployed + verified in browser:** the Draft Studio "New draft" button
  (maestro `17c075b80caf`). Three stacked causes fixed — API gated on the wrong
  session cookie (`cr_session` vs `gsuite_session`), no `AuthGate` on the pages,
  and a Workers-cache bug serving a stale `authed:false` for the session check
  (PRs #53, #54, #55, #56).
- **Shipped but sloppy — to be removed (CEE-8):** an interim "agent revise" was
  hand-rolled (a `Textarea` + a `<div>` diff) in `2ca10ff` instead of the pro
  blocks. It works but is not the real feature.
- **Installed:** `ai-chat-13` (`src/components/blocks/ai-chat-13`).
- **Uncommitted (CEE-7):** `guardianRun` interface extended for
  `useCase`/`task`/`capabilities`/`budgetUsd`.

## Resume here

Start at **CEE-1** (the merged extension set) — it is the critical path; CEE-2/3
(RTE1/RTE2 surfaces) and CEE-5 (RTE3 suggesting) all sit on top of it. CEE-7
(Guardian use-case backend) and CEE-9 (MCP CRUD) are independent and can go in
parallel. CEE-8 (remove the slop) happens as the combined editor replaces it.

## Task breakdown

| ID | Task | Pri | Status |
|---|---|---|---|
| `a456f9d48684` | CEE-1 Foundation: merged Tiptap extension set | high | todo |
| `5670d7f455cb` | CEE-2 RTE1 surface: toolbar, link bubble, task lists, word+char count | med | todo |
| `14bb054a6e56` | CEE-3 RTE2 surface: slash menu, mentions, resizable tables, outline rail | med | todo |
| `197ae5664fb1` | CEE-4 Slash commands → colby email skills + /review | high | todo |
| `a7b739e6a0fd` | CEE-5 RTE3 suggesting: accept/reject cards, final-vs-original, sticky margin | high | todo |
| `a858af5ffe16` | CEE-6 ai-chat-13 assistant window (full doc visible) | med | todo |
| `75f28f07ba90` | CEE-7 Backend /suggest via Core Guardian use-case routing | high | todo |
| `74ef05608d86` | CEE-8 Remove increment-1 slop (RevisePanel/SuggestionReview) | high | todo |
| `61e9c81c66e4` | CEE-9 Full draft CRUD over MCP (add discard/delete) | high | todo |
| `006ac133d10c` | CEE-10 Tests seen-to-fail across the combined editor | med | backlog |
