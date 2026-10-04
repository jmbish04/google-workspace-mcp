/**
 * @fileoverview The operations behind the agent document-editing MCP tools.
 *
 * This is the surface an agent uses to work a collaborative document the way a
 * person does: read it structured, propose tracked suggestions against text
 * anchors, comment on and reply to threads, and apply or withdraw its OWN
 * suggestions. It composes three lower layers and adds no second realtime path:
 *
 *  - {@link DocumentStore} — Postgres system of record (CRUD).
 *  - {@link notifyReviewRoom} — the draft-studio-style live cue so an open
 *    editor re-reads without a refresh (Task B).
 *  - {@link applyTextChange} — the pure Tiptap/ProseMirror text transform used
 *    only when the agent APPLIES one of its own already-tracked suggestions.
 *
 * ## Why there is no "write straight into the document" operation
 * Agent edits are SUGGESTIONS by default. The only path that mutates
 * `documents.content` is {@link DocumentAgentService.applySuggestion}, and it
 * refuses anything but a PENDING suggestion the agent itself authored — so every
 * content change was first a reviewable object in the dock, never a silent
 * overwrite.
 */
import { DocumentStore } from "@/backend/documents/store";
import { notifyReviewRoom, type DocumentReviewActor } from "@/backend/documents/review-notify";
import {
  applyTextChange,
  extractBlocks,
  type DocBlock,
  type PMNode,
  type TextAnchor,
  type TextChange,
} from "@/backend/documents/prosemirror-text";
import type {
  CommentRow,
  DocumentRow,
  SuggestionRow,
} from "@/backend/db/schemas/documents";

/** Marks an author string as a Claude-farm agent, distinct from a human email. */
export const AGENT_AUTHOR_PREFIX = "agent:";

/** The author value stamped on every suggestion/comment an agent creates. */
export function agentAuthor(sub: string): string {
  return `${AGENT_AUTHOR_PREFIX}${sub}`;
}

/** A single proposed edit: where to anchor it and what to change. */
export interface SuggestionInput {
  anchor: TextAnchor;
  change: TextChange;
  /** One human-readable line on why, shown in the review dock. */
  note?: string;
}

/** Structured, HTML-free view of a document for an agent to reason over. */
export interface StructuredDocument {
  id: string;
  title: string;
  owner: string;
  revision: number;
  updatedAt: Date;
  blocks: DocBlock[];
  openSuggestions: SuggestionSummary[];
  openThreads: CommentThread[];
  content?: PMNode;
}

/** Compact suggestion shape returned to the model. */
export interface SuggestionSummary {
  id: string;
  author: string;
  byAgent: boolean;
  status: "pending" | "accepted" | "rejected";
  anchor: TextAnchor;
  change: TextChange;
  note?: string;
  createdAt: Date;
}

/** A comment thread: its root plus replies, resolution, and anchor. */
export interface CommentThread {
  threadId: string;
  resolved: boolean;
  anchor: unknown;
  comments: Array<{
    id: string;
    author: string;
    byAgent: boolean;
    body: string;
    parentId: string | null;
    createdAt: Date;
  }>;
}

const isAgent = (author: string) => author.startsWith(AGENT_AUTHOR_PREFIX);

function toSuggestionSummary(row: SuggestionRow): SuggestionSummary {
  const anchor = (row.anchor ?? {}) as unknown as TextAnchor & { note?: string };
  const change = (row.proposedChange ?? {}) as TextChange;
  return {
    id: row.id,
    author: row.author,
    byAgent: isAgent(row.author),
    status: row.status,
    anchor: { find: anchor.find, occurrence: anchor.occurrence, blockIndex: anchor.blockIndex },
    change,
    note: anchor.note,
    createdAt: row.createdAt,
  };
}

/** Group a document's comment rows into threads (root + replies), newest thread first. */
function toThreads(rows: CommentRow[]): CommentThread[] {
  const byThread = new Map<string, CommentRow[]>();
  for (const row of rows) {
    const list = byThread.get(row.threadId) ?? [];
    list.push(row);
    byThread.set(row.threadId, list);
  }
  return [...byThread.values()].map((list) => {
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const root = sorted[0]!;
    return {
      threadId: root.threadId,
      resolved: sorted.every((c) => c.resolved),
      anchor: root.anchor,
      comments: sorted.map((c) => ({
        id: c.id,
        author: c.author,
        byAgent: isAgent(c.author),
        body: c.body,
        parentId: c.parentId,
        createdAt: c.createdAt,
      })),
    };
  });
}

/** Thrown when a document (or suggestion/comment) the agent named does not exist. */
export class DocumentNotFoundError extends Error {}
/** Thrown when the agent tries to apply/withdraw a suggestion that is not its own pending one. */
export class SuggestionOwnershipError extends Error {}

/**
 * Agent-facing document operations. Construct per request; the store is
 * injectable so the behaviour can be tested against a recording store with no
 * network.
 */
export class DocumentAgentService {
  /**
   * @param env - Worker bindings (used for the live-cue namespace; may be a stub in tests).
   * @param store - Persistence facade; defaults to a real Postgres-backed store.
   */
  constructor(
    private readonly env: Env,
    private readonly store: DocumentStore = new DocumentStore(env),
  ) {}

  /** Load a document or throw {@link DocumentNotFoundError}. */
  private async requireDocument(docId: string): Promise<DocumentRow> {
    const doc = await this.store.getDocument(docId);
    if (!doc) throw new DocumentNotFoundError(`Document ${docId} not found.`);
    return doc;
  }

  private notify = (
    docId: string,
    event: Parameters<typeof notifyReviewRoom>[2],
  ): Promise<void> => notifyReviewRoom(this.env, docId, event);

  /**
   * Read a document STRUCTURED — blocks of plain text plus its open review
   * queue — never raw HTML.
   * @param docId - Document UUID.
   * @param opts - `includeContent` to also return the raw Tiptap JSON.
   * @returns The structured document.
   * @throws DocumentNotFoundError when the document is missing.
   */
  async read(docId: string, opts: { includeContent?: boolean } = {}): Promise<StructuredDocument> {
    const doc = await this.requireDocument(docId);
    const [suggestions, comments] = await Promise.all([
      this.store.listSuggestions(docId, "pending"),
      this.store.listComments(docId, false),
    ]);
    return {
      id: doc.id,
      title: doc.title,
      owner: doc.owner,
      revision: doc.revision,
      updatedAt: doc.updatedAt,
      blocks: extractBlocks(doc.content),
      openSuggestions: suggestions.map(toSuggestionSummary),
      openThreads: toThreads(comments),
      ...(opts.includeContent ? { content: doc.content as PMNode } : {}),
    };
  }

  /** List documents, newest-updated first, optionally scoped to an owner. */
  async list(owner?: string) {
    const rows = await this.store.listDocuments(owner);
    return rows.map((d) => ({
      id: d.id,
      title: d.title,
      owner: d.owner,
      revision: d.revision,
      updatedAt: d.updatedAt,
    }));
  }

  /** Create a new document from plain-text paragraphs or raw Tiptap JSON. */
  async create(input: { title: string; owner: string; text?: string; content?: PMNode }) {
    const content =
      input.content ??
      ({
        type: "doc",
        content: (input.text ?? "")
          .split(/\n{2,}/)
          .map((para) => para.trim())
          .filter(Boolean)
          .map((para) => ({ type: "paragraph", content: [{ type: "text", text: para }] })),
      } as PMNode);
    const doc = await this.store.createDocument({
      title: input.title,
      owner: input.owner,
      content: content as Record<string, unknown>,
    });
    return { id: doc.id, title: doc.title, owner: doc.owner, revision: doc.revision };
  }

  /**
   * Propose ONE tracked suggestion against a text anchor. Creates a pending
   * suggestion (never touches content) and cues open editors.
   * @returns The created suggestion summary.
   */
  async suggest(docId: string, sub: string, input: SuggestionInput): Promise<SuggestionSummary> {
    await this.requireDocument(docId);
    const row = await this.store.createSuggestion({
      docId,
      author: agentAuthor(sub),
      anchor: { ...input.anchor, note: input.note } as Record<string, unknown>,
      proposedChange: input.change as unknown as Record<string, unknown>,
    });
    await this.notify(docId, {
      type: "suggestion",
      suggestionId: row.id,
      action: "created",
      by: "agent",
    });
    return toSuggestionSummary(row);
  }

  /**
   * Propose a BATCH of tracked suggestions. Each is persisted; open editors get
   * one aggregate cue so they re-read all of them at once.
   * @returns The created suggestion summaries, in input order.
   */
  async suggestBatch(
    docId: string,
    sub: string,
    inputs: SuggestionInput[],
  ): Promise<SuggestionSummary[]> {
    await this.requireDocument(docId);
    const created: SuggestionSummary[] = [];
    for (const input of inputs) {
      const row = await this.store.createSuggestion({
        docId,
        author: agentAuthor(sub),
        anchor: { ...input.anchor, note: input.note } as Record<string, unknown>,
        proposedChange: input.change as unknown as Record<string, unknown>,
      });
      created.push(toSuggestionSummary(row));
    }
    await this.notify(docId, { type: "suggestions", count: created.length, by: "agent" });
    return created;
  }

  /** Leave a comment that opens a new thread, anchored to a passage. */
  async comment(
    docId: string,
    sub: string,
    input: { anchor: unknown; body: string },
  ): Promise<{ commentId: string; threadId: string }> {
    await this.requireDocument(docId);
    const row = await this.store.createComment({
      docId,
      author: agentAuthor(sub),
      anchor: (input.anchor ?? {}) as Record<string, unknown>,
      body: input.body,
    });
    await this.notify(docId, {
      type: "comment",
      commentId: row.id,
      threadId: row.threadId,
      action: "created",
      by: "agent",
    });
    return { commentId: row.id, threadId: row.threadId };
  }

  /**
   * Reply within an existing thread. The parent comment supplies the document,
   * thread, and anchor, so a reply can never drift onto the wrong passage.
   */
  async reply(
    parentCommentId: string,
    sub: string,
    body: string,
  ): Promise<{ commentId: string; threadId: string }> {
    const parent = await this.store.getComment(parentCommentId);
    if (!parent) throw new DocumentNotFoundError(`Comment ${parentCommentId} not found.`);
    const row = await this.store.createComment({
      docId: parent.docId,
      author: agentAuthor(sub),
      anchor: parent.anchor,
      body,
      threadId: parent.threadId,
      parentId: parent.id,
    });
    await this.notify(parent.docId, {
      type: "comment",
      commentId: row.id,
      threadId: row.threadId,
      action: "reply",
      by: "agent",
    });
    return { commentId: row.id, threadId: row.threadId };
  }

  /**
   * Resolve (or reopen) every comment in a thread. Accepts any comment id in the
   * thread; the whole thread flips together.
   * @returns The thread id and how many comments changed.
   */
  async resolveThread(
    anyCommentId: string,
    resolved: boolean,
    _sub: string,
  ): Promise<{ threadId: string; updated: number; resolved: boolean }> {
    const seed = await this.store.getComment(anyCommentId);
    if (!seed) throw new DocumentNotFoundError(`Comment ${anyCommentId} not found.`);
    const all = await this.store.listComments(seed.docId);
    const inThread = all.filter((c) => c.threadId === seed.threadId);
    let updated = 0;
    for (const c of inThread) {
      if (c.resolved !== resolved) {
        await this.store.updateComment(c.id, { resolved });
        updated += 1;
      }
    }
    await this.notify(seed.docId, {
      type: "comment",
      commentId: seed.id,
      threadId: seed.threadId,
      action: resolved ? "resolved" : "reopened",
      by: "agent",
    });
    return { threadId: seed.threadId, updated, resolved };
  }

  /** List the review queue: suggestions (by status) and comment threads. */
  async reviewList(
    docId: string,
    opts: { status?: "pending" | "accepted" | "rejected"; includeResolved?: boolean } = {},
  ): Promise<{ suggestions: SuggestionSummary[]; threads: CommentThread[] }> {
    await this.requireDocument(docId);
    const [suggestions, comments] = await Promise.all([
      this.store.listSuggestions(docId, opts.status),
      this.store.listComments(docId, opts.includeResolved ? undefined : false),
    ]);
    return { suggestions: suggestions.map(toSuggestionSummary), threads: toThreads(comments) };
  }

  /**
   * APPLY the agent's own pending suggestion: the one explicit, named path that
   * edits `documents.content`. Refuses anything that is not a pending suggestion
   * this agent authored, and refuses an anchor that no longer resolves cleanly —
   * so an apply is always the promotion of a reviewable object, never a blind
   * overwrite.
   *
   * @param suggestionId - The suggestion to apply.
   * @param sub - The calling agent's identity (must match the suggestion's author).
   * @returns `{ ok:true, revision, before, after }` on success, or
   *   `{ ok:false, reason, matches }` when the anchor can't be applied cleanly.
   * @throws SuggestionOwnershipError when the suggestion is not the agent's own pending one.
   */
  async applySuggestion(
    suggestionId: string,
    sub: string,
  ): Promise<
    | { ok: true; suggestionId: string; revision: number; before: string; after: string }
    | { ok: false; reason: string; matches: number }
  > {
    const suggestion = await this.store.getSuggestion(suggestionId);
    if (!suggestion) throw new DocumentNotFoundError(`Suggestion ${suggestionId} not found.`);
    if (suggestion.author !== agentAuthor(sub)) {
      throw new SuggestionOwnershipError(
        "An agent may only apply a PENDING suggestion it authored itself. Accepting a human's suggestion is the reviewer's decision, made in the editor.",
      );
    }
    if (suggestion.status !== "pending") {
      throw new SuggestionOwnershipError(`Suggestion ${suggestionId} is already ${suggestion.status}.`);
    }
    const doc = await this.requireDocument(suggestion.docId);
    const anchor = suggestion.anchor as unknown as TextAnchor;
    const change = suggestion.proposedChange as unknown as TextChange;
    const result = applyTextChange(doc.content, anchor, change);
    if (!result.ok) {
      return { ok: false, reason: result.reason, matches: result.matches };
    }
    const nextRevision = doc.revision + 1;
    await this.store.updateDocument(doc.id, {
      content: result.content as Record<string, unknown>,
      revision: nextRevision,
    });
    await this.store.updateSuggestion(suggestionId, { status: "accepted" });
    await this.notify(doc.id, { type: "document", revision: nextRevision, by: "agent" });
    await this.notify(doc.id, {
      type: "suggestion",
      suggestionId,
      action: "accepted",
      by: "agent",
    });
    return { ok: true, suggestionId, revision: nextRevision, before: result.before, after: result.after };
  }

  /**
   * WITHDRAW the agent's own pending suggestion (retract a proposal before a
   * human acts on it). Marks it rejected; never touches content.
   * @throws SuggestionOwnershipError when the suggestion is not the agent's own pending one.
   */
  async withdrawSuggestion(
    suggestionId: string,
    sub: string,
  ): Promise<{ suggestionId: string; status: "rejected" }> {
    const suggestion = await this.store.getSuggestion(suggestionId);
    if (!suggestion) throw new DocumentNotFoundError(`Suggestion ${suggestionId} not found.`);
    if (suggestion.author !== agentAuthor(sub)) {
      throw new SuggestionOwnershipError("An agent may only withdraw a suggestion it authored itself.");
    }
    if (suggestion.status !== "pending") {
      throw new SuggestionOwnershipError(`Suggestion ${suggestionId} is already ${suggestion.status}.`);
    }
    await this.store.updateSuggestion(suggestionId, { status: "rejected" });
    await this.notify(suggestion.docId, {
      type: "suggestion",
      suggestionId,
      action: "withdrawn",
      by: "agent",
    });
    return { suggestionId, status: "rejected" };
  }
}

export type { DocumentReviewActor };
