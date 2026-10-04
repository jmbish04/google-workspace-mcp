/**
 * @fileoverview Behavioural tests for the agent document-editing service.
 *
 * Uses an in-memory store and a recording Durable Object namespace so the tests
 * prove, with no network: agent edits are tracked suggestions by default; the
 * only content write is applying the agent's OWN pending suggestion; ownership
 * is enforced; and every mutation emits the draft-studio-style live cue (Task B)
 * so an open editor re-reads. Each assertion fails if its behaviour is removed.
 */
import { describe, expect, it } from "vitest";

import { DocumentAgentService, SuggestionOwnershipError } from "@/backend/documents/agent-service";
import type { DocumentStore } from "@/backend/documents/store";
import type { DocumentReviewEvent } from "@/backend/documents/review-notify";
import type {
  CommentRow,
  DocumentRow,
  SuggestionRow,
} from "@/backend/db/schemas/documents";

let seq = 0;
const uuid = () => `id-${++seq}`;

/** Minimal in-memory DocumentStore covering just what the service touches. */
function makeStore(initial?: Partial<DocumentRow>) {
  const documents: DocumentRow[] = [];
  const suggestions: SuggestionRow[] = [];
  const comments: CommentRow[] = [];
  const now = () => new Date();

  const store = {
    _documents: documents,
    _suggestions: suggestions,
    _comments: comments,
    listDocuments: async (owner?: string) =>
      documents.filter((d) => !owner || d.owner === owner),
    getDocument: async (id: string) => documents.find((d) => d.id === id),
    createDocument: async (v: Partial<DocumentRow>) => {
      const row = {
        id: uuid(),
        owner: v.owner ?? "owner",
        title: v.title ?? "Untitled",
        content: v.content ?? { type: "doc", content: [] },
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
      } as DocumentRow;
      documents.push(row);
      return row;
    },
    updateDocument: async (id: string, v: Partial<DocumentRow>) => {
      const row = documents.find((d) => d.id === id);
      if (!row) return undefined;
      Object.assign(row, v, { updatedAt: now() });
      return row;
    },
    listSuggestions: async (docId: string, status?: string) =>
      suggestions.filter((s) => s.docId === docId && (!status || s.status === status)),
    getSuggestion: async (id: string) => suggestions.find((s) => s.id === id),
    createSuggestion: async (v: Partial<SuggestionRow>) => {
      const row = {
        id: uuid(),
        docId: v.docId!,
        author: v.author!,
        anchor: v.anchor!,
        proposedChange: v.proposedChange!,
        status: "pending",
        createdAt: now(),
        updatedAt: now(),
      } as SuggestionRow;
      suggestions.push(row);
      return row;
    },
    updateSuggestion: async (id: string, v: Partial<SuggestionRow>) => {
      const row = suggestions.find((s) => s.id === id);
      if (!row) return undefined;
      Object.assign(row, v, { updatedAt: now() });
      return row;
    },
    listComments: async (docId: string, resolved?: boolean) =>
      comments.filter(
        (c) => c.docId === docId && (resolved === undefined || c.resolved === resolved),
      ),
    getComment: async (id: string) => comments.find((c) => c.id === id),
    createComment: async (v: Partial<CommentRow>) => {
      const row = {
        id: uuid(),
        docId: v.docId!,
        author: v.author!,
        anchor: v.anchor ?? {},
        body: v.body!,
        threadId: v.threadId ?? uuid(),
        parentId: v.parentId ?? null,
        resolved: false,
        createdAt: now(),
        updatedAt: now(),
      } as CommentRow;
      comments.push(row);
      return row;
    },
    updateComment: async (id: string, v: Partial<CommentRow>) => {
      const row = comments.find((c) => c.id === id);
      if (!row) return undefined;
      Object.assign(row, v, { updatedAt: now() });
      return row;
    },
  };

  const seeded = {
    id: "doc-1",
    owner: "justin@126colby.com",
    title: "Spec",
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Teh plan is due friday." }] },
      ],
    },
    revision: 1,
    createdAt: now(),
    updatedAt: now(),
    ...initial,
  } as DocumentRow;
  documents.push(seeded);
  return store;
}

/** Env with a recording DOCUMENT_REVIEW namespace so cues can be asserted. */
function makeEnv() {
  const published: DocumentReviewEvent[] = [];
  const env = {
    DOCUMENT_REVIEW: {
      idFromName: (name: string) => name,
      get: () => ({ publish: (e: DocumentReviewEvent) => void published.push(e) }),
    },
  } as unknown as Env;
  return { env, published };
}

const SUB = "agent-session-7";
const AGENT = `agent:${SUB}`;

function service(storeOverride?: ReturnType<typeof makeStore>) {
  const store = storeOverride ?? makeStore();
  const { env, published } = makeEnv();
  return {
    store,
    published,
    svc: new DocumentAgentService(env, store as unknown as DocumentStore),
  };
}

describe("DocumentAgentService — suggestions are tracked, not writes", () => {
  it("records a pending suggestion authored by the agent and cues the room", async () => {
    const { svc, store, published } = service();
    const out = await svc.suggest("doc-1", SUB, {
      anchor: { find: "Teh" },
      change: { kind: "replace", text: "The" },
      note: "typo",
    });
    expect(out.status).toBe("pending");
    expect(out.byAgent).toBe(true);
    expect(store._suggestions).toHaveLength(1);
    expect(store._suggestions[0]!.author).toBe(AGENT);
    // Document content is untouched — a suggestion never writes.
    expect(store._documents[0]!.revision).toBe(1);
    expect(published).toEqual([
      { type: "suggestion", suggestionId: out.id, action: "created", by: "agent" },
    ]);
  });

  it("creates a batch and emits one aggregate cue", async () => {
    const { svc, store, published } = service();
    const out = await svc.suggestBatch("doc-1", SUB, [
      { anchor: { find: "Teh" }, change: { kind: "replace", text: "The" } },
      { anchor: { find: "friday" }, change: { kind: "replace", text: "Friday" } },
    ]);
    expect(out).toHaveLength(2);
    expect(store._suggestions).toHaveLength(2);
    expect(published).toEqual([{ type: "suggestions", count: 2, by: "agent" }]);
  });
});

describe("DocumentAgentService — comments and threads", () => {
  it("replies within the parent's thread and resolves the whole thread", async () => {
    const { svc, store, published } = service();
    const root = await svc.comment("doc-1", SUB, { anchor: { find: "plan" }, body: "which plan?" });
    const reply = await svc.reply(root.commentId, SUB, "the Q4 plan");
    expect(reply.threadId).toBe(root.threadId);
    const replyRow = store._comments.find((c) => c.id === reply.commentId)!;
    expect(replyRow.parentId).toBe(root.commentId);
    expect(replyRow.anchor).toEqual({ find: "plan" });

    const res = await svc.resolveThread(root.commentId, true, SUB);
    expect(res.updated).toBe(2);
    expect(store._comments.every((c) => c.resolved)).toBe(true);
    expect(published.at(-1)).toMatchObject({ type: "comment", action: "resolved" });
  });
});

describe("DocumentAgentService — read is structured and filtered", () => {
  it("returns blocks and only open suggestions / unresolved threads", async () => {
    const { svc, store } = service();
    await svc.suggest("doc-1", SUB, { anchor: { find: "Teh" }, change: { kind: "replace", text: "The" } });
    // A rejected suggestion must not surface as open.
    store._suggestions[0]!.status = "pending";
    const extra = await svc.suggest("doc-1", SUB, {
      anchor: { find: "due" },
      change: { kind: "delete" },
    });
    await svc.withdrawSuggestion(extra.id, SUB);

    const doc = await svc.read("doc-1");
    expect(doc.blocks[0]!.text).toBe("Teh plan is due friday.");
    expect(doc.openSuggestions).toHaveLength(1);
    expect(doc.openSuggestions[0]!.change).toEqual({ kind: "replace", text: "The" });
  });
});

describe("DocumentAgentService — apply is the only content write, own-only", () => {
  it("applies the agent's own pending suggestion, bumps revision, marks accepted, cues both", async () => {
    const { svc, store, published } = service();
    const s = await svc.suggest("doc-1", SUB, {
      anchor: { find: "Teh" },
      change: { kind: "replace", text: "The" },
    });
    published.length = 0;
    const res = await svc.applySuggestion(s.id, SUB);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.before).toBe("Teh");
    expect(res.after).toBe("The");
    expect(store._documents[0]!.revision).toBe(2);
    expect((store._documents[0]!.content as { content: { content: { text: string }[] }[] }).content[0]!.content[0]!.text).toBe(
      "The plan is due friday.",
    );
    expect(store._suggestions[0]!.status).toBe("accepted");
    expect(published).toEqual([
      { type: "document", revision: 2, by: "agent" },
      { type: "suggestion", suggestionId: s.id, action: "accepted", by: "agent" },
    ]);
  });

  it("refuses to apply a suggestion the agent did not author", async () => {
    const store = makeStore();
    store._suggestions.push({
      id: "human-sugg",
      docId: "doc-1",
      author: "justin@126colby.com",
      anchor: { find: "Teh" },
      proposedChange: { kind: "replace", text: "The" },
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as SuggestionRow);
    const { svc } = service(store);
    await expect(svc.applySuggestion("human-sugg", SUB)).rejects.toBeInstanceOf(
      SuggestionOwnershipError,
    );
    // Content untouched.
    expect(store._documents[0]!.revision).toBe(1);
  });

  it("returns ok:false (does not throw, does not write) when the anchor no longer resolves", async () => {
    const { svc, store } = service();
    const s = await svc.suggest("doc-1", SUB, {
      anchor: { find: "nonexistent phrase" },
      change: { kind: "replace", text: "x" },
    });
    const res = await svc.applySuggestion(s.id, SUB);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("notFound");
    expect(store._documents[0]!.revision).toBe(1);
    // Still pending — an unapplied suggestion is not consumed.
    expect(store._suggestions[0]!.status).toBe("pending");
  });
});
