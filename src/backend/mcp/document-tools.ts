/**
 * @fileoverview MCP tool family for agent document editing (Phase 5, Task A).
 *
 * The surface an agent uses to work a collaborative document the way a person
 * does: read it STRUCTURED (never raw HTML), propose a tracked suggestion or a
 * batch of them against text anchors, comment on a passage, reply to and resolve
 * a thread, list the open review queue, and apply or withdraw its OWN
 * suggestions.
 *
 * These are registered in {@link TOOLS} (spread in from `tools.ts`) but NOT in
 * `MCP_EXPOSED_TOOLS`: this server is code-mode-only, so they are reachable
 * in-sandbox via `await tools.<name>(args)`, not advertised on `tools/list`.
 *
 * ## Agent edits are suggestions by default
 * Nine of these eleven tools only ever create reviewable objects. The single
 * path that mutates document content, `document_suggestion_apply`, promotes a
 * PENDING suggestion the agent itself authored — it is the explicit, named
 * reason the review dock is not bypassed, not a "write straight into the doc"
 * tool. No such silent-overwrite tool exists here, by design.
 *
 * All work routes through {@link DocumentAgentService}; every call flows through
 * the central tool-runner like any other tool.
 */
import { z } from "zod";

import { DocumentAgentService } from "@/backend/documents/agent-service";

import type { ToolDef } from "./tools";

/** A stable text anchor the model targets instead of a brittle character offset. */
const anchorSchema = z
  .object({
    find: z.string().min(1).describe("Exact substring to locate (must fall within one styled run)."),
    occurrence: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("1-based occurrence when `find` repeats. Defaults to 1."),
    blockIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Restrict to this top-level block index (from document_read.blocks)."),
  })
  .describe("Where the suggestion attaches.");

/** What a located span becomes when the suggestion is applied. */
const changeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("replace"), text: z.string().describe("Replacement text.") }),
    z.object({ kind: z.literal("insert_before"), text: z.string().describe("Text inserted before the match.") }),
    z.object({ kind: z.literal("insert_after"), text: z.string().describe("Text inserted after the match.") }),
    z.object({ kind: z.literal("delete") }),
  ])
  .describe("The proposed edit.");

const suggestionInputSchema = z.object({
  anchor: anchorSchema,
  change: changeSchema,
  note: z.string().optional().describe("One line on why, shown in the review dock."),
});

const suggestionSummaryShape = z.object({
  id: z.string(),
  author: z.string(),
  byAgent: z.boolean(),
  status: z.enum(["pending", "accepted", "rejected"]),
  anchor: z.record(z.string(), z.unknown()),
  change: z.record(z.string(), z.unknown()),
  note: z.string().optional(),
  createdAt: z.unknown(),
});

const threadShape = z.object({
  threadId: z.string(),
  resolved: z.boolean(),
  anchor: z.unknown(),
  comments: z.array(
    z.object({
      id: z.string(),
      author: z.string(),
      byAgent: z.boolean(),
      body: z.string(),
      parentId: z.string().nullable(),
      createdAt: z.unknown(),
    }),
  ),
});

/** Construct the per-request service. */
const svc = (ctx: { env: Env }) => new DocumentAgentService(ctx.env);

/**
 * The agent document-editing tool family, spread into {@link TOOLS}.
 * @example tools.document_read({ docId })
 */
export const documentAgentTools: ToolDef[] = [
  {
    name: "document_list",
    description:
      "List collaborative documents (the first-class docs with tracked suggestions and comments — NOT Google Drive files), newest-updated first. Optional `owner` filter. Use this to find a document id to work on.",
    inputSchema: z.object({ owner: z.string().optional() }),
    outputSchema: z.object({
      documents: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          owner: z.string(),
          revision: z.number(),
          updatedAt: z.unknown(),
        }),
      ),
    }),
    async run(ctx, a) {
      return { result: { documents: await svc(ctx).list(a.owner) } };
    },
  },
  {
    name: "document_read",
    description:
      "Read a collaborative document STRUCTURED — its ordered blocks of plain text (never raw HTML) plus its open review queue (pending suggestions and unresolved comment threads). Anchor every suggestion to text you saw here. Pass `includeContent:true` only when you need the raw Tiptap JSON.",
    inputSchema: z.object({
      docId: z.string().describe("Document UUID."),
      includeContent: z.boolean().optional(),
    }),
    outputSchema: z.object({
      id: z.string(),
      title: z.string(),
      owner: z.string(),
      revision: z.number(),
      updatedAt: z.unknown(),
      blocks: z.array(
        z.object({ index: z.number(), type: z.string(), text: z.string(), level: z.number().optional() }),
      ),
      openSuggestions: z.array(suggestionSummaryShape),
      openThreads: z.array(threadShape),
      content: z.unknown().optional(),
    }),
    async run(ctx, a) {
      return { result: await svc(ctx).read(a.docId, { includeContent: a.includeContent }) };
    },
  },
  {
    name: "document_create",
    description:
      "Create a new collaborative document from plain-text paragraphs (split on blank lines) or raw Tiptap/ProseMirror JSON. Returns its id. Creating a fresh document is not an overwrite — this never mutates an existing doc's content.",
    inputSchema: z
      .object({
        title: z.string().min(1),
        owner: z.string().optional().describe("Defaults to the calling identity."),
        text: z.string().optional().describe("Plain text; blank lines separate paragraphs."),
        content: z.record(z.string(), z.unknown()).optional().describe("Raw Tiptap JSON doc node."),
      })
      .refine((v) => v.text != null || v.content != null, {
        message: "Provide `text` or `content`.",
      }),
    outputSchema: z.object({
      id: z.string(),
      title: z.string(),
      owner: z.string(),
      revision: z.number(),
    }),
    async run(ctx, a) {
      return {
        result: await svc(ctx).create({
          title: a.title,
          owner: a.owner ?? ctx.sub,
          text: a.text,
          content: a.content as never,
        }),
      };
    },
  },
  {
    name: "document_suggest",
    description:
      "Propose ONE tracked suggestion against a text anchor. It appears in the review dock as a pending change for a human to accept or reject — it does NOT edit the document. Agent edits are suggestions by default; this is the normal way to change a document.",
    inputSchema: z.object({
      docId: z.string(),
      anchor: anchorSchema,
      change: changeSchema,
      note: z.string().optional().describe("One line on why, shown in the review dock."),
    }),
    outputSchema: suggestionSummaryShape,
    async run(ctx, a) {
      return {
        result: await svc(ctx).suggest(a.docId, ctx.sub, {
          anchor: a.anchor,
          change: a.change,
          note: a.note,
        }),
      };
    },
  },
  {
    name: "document_suggest_batch",
    description:
      "Propose a BATCH of tracked suggestions in one call (e.g. a pass of edits across a document). Each becomes its own pending review-dock object; open editors get one aggregate live cue. Nothing is written to the document.",
    inputSchema: z.object({
      docId: z.string(),
      suggestions: z.array(suggestionInputSchema).min(1).max(100),
    }),
    outputSchema: z.object({ suggestions: z.array(suggestionSummaryShape) }),
    async run(ctx, a) {
      return {
        result: { suggestions: await svc(ctx).suggestBatch(a.docId, ctx.sub, a.suggestions) },
      };
    },
  },
  {
    name: "document_comment",
    description:
      "Leave a comment that opens a new thread, anchored to a passage. Use for questions or observations that are not a concrete edit. Returns the new comment and thread ids.",
    inputSchema: z.object({
      docId: z.string(),
      body: z.string().min(1),
      anchor: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional anchor describing the passage (e.g. { find, blockIndex })."),
    }),
    outputSchema: z.object({ commentId: z.string(), threadId: z.string() }),
    async run(ctx, a) {
      return {
        result: await svc(ctx).comment(a.docId, ctx.sub, { anchor: a.anchor ?? {}, body: a.body }),
      };
    },
  },
  {
    name: "document_comment_reply",
    description:
      "Reply within an existing comment thread. The parent comment supplies the document, thread, and anchor, so the reply stays on the right passage. Pass the id of the comment you are replying to.",
    inputSchema: z.object({
      parentCommentId: z.string(),
      body: z.string().min(1),
    }),
    outputSchema: z.object({ commentId: z.string(), threadId: z.string() }),
    async run(ctx, a) {
      return { result: await svc(ctx).reply(a.parentCommentId, ctx.sub, a.body) };
    },
  },
  {
    name: "document_comment_resolve",
    description:
      "Resolve (or reopen) a whole comment thread. Pass any comment id in the thread; every comment in it flips together. Defaults to resolving; pass `resolved:false` to reopen.",
    inputSchema: z.object({
      commentId: z.string().describe("Any comment id in the thread."),
      resolved: z.boolean().optional().describe("Defaults to true (resolve)."),
    }),
    outputSchema: z.object({
      threadId: z.string(),
      updated: z.number(),
      resolved: z.boolean(),
    }),
    async run(ctx, a) {
      return {
        result: await svc(ctx).resolveThread(a.commentId, a.resolved ?? true, ctx.sub),
      };
    },
  },
  {
    name: "document_review_list",
    description:
      "List a document's review queue: its suggestions (by status; default all) and its comment threads. Pass `status` to filter suggestions (pending/accepted/rejected) and `includeResolved:true` to include resolved threads.",
    inputSchema: z.object({
      docId: z.string(),
      status: z.enum(["pending", "accepted", "rejected"]).optional(),
      includeResolved: z.boolean().optional(),
    }),
    outputSchema: z.object({
      suggestions: z.array(suggestionSummaryShape),
      threads: z.array(threadShape),
    }),
    async run(ctx, a) {
      return {
        result: await svc(ctx).reviewList(a.docId, {
          status: a.status,
          includeResolved: a.includeResolved,
        }),
      };
    },
  },
  {
    name: "document_suggestion_apply",
    description:
      "Apply the agent's OWN pending suggestion — the one path that edits document content. It only works on a pending suggestion THIS agent authored (it cannot accept a human's suggestion — that is the reviewer's decision), and it refuses an anchor that no longer resolves to exactly one text run, returning { ok:false, reason } instead of guessing. On success the document revision bumps and open editors update live. Prefer leaving suggestions for a human to accept unless you have been asked to apply your own edits.",
    inputSchema: z.object({ suggestionId: z.string() }),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        suggestionId: z.string(),
        revision: z.number(),
        before: z.string(),
        after: z.string(),
      }),
      z.object({ ok: z.literal(false), reason: z.string(), matches: z.number() }),
    ]),
    async run(ctx, a) {
      return { result: await svc(ctx).applySuggestion(a.suggestionId, ctx.sub) };
    },
  },
  {
    name: "document_suggestion_withdraw",
    description:
      "Withdraw the agent's OWN pending suggestion (retract a proposal before a human acts on it). Marks it rejected; never touches document content. Only works on a pending suggestion this agent authored.",
    inputSchema: z.object({ suggestionId: z.string() }),
    outputSchema: z.object({ suggestionId: z.string(), status: z.literal("rejected") }),
    async run(ctx, a) {
      return { result: await svc(ctx).withdrawSuggestion(a.suggestionId, ctx.sub) };
    },
  },
];
