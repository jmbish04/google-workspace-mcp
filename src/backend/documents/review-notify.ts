/**
 * @file documents/review-notify.ts
 * @description How the rest of the worker tells an open editor that a review
 * object (a suggestion or comment) changed — the suggestion/comment analogue of
 * {@link file://../gmail/draft-room-notify.ts}.
 *
 * ## Relationship to the Yjs collaboration room
 * Phase 3's {@link file://./collaboration-room.ts} `DocumentCollaborationRoom`
 * is a STATEFUL Yjs CRDT room that syncs the document BODY over binary
 * y-websocket frames (its sockets reject string frames). This is a DIFFERENT,
 * complementary channel: suggestions and comments are first-class Postgres rows,
 * not part of the Y.Doc, so an edit to them is broadcast as a tiny JSON cue that
 * tells the editor's review dock to re-read Postgres. It is the stateless
 * "DO holds no authoritative state; the cue just says re-read" pattern — it does
 * not duplicate the CRDT body path, and the two cannot share a socket.
 *
 * Deliberately separate from `review-room.ts`: that module imports
 * `cloudflare:workers` for the Durable Object base class, which only resolves
 * inside workerd. Everything that merely NOTIFIES — the document agent service,
 * and so the whole MCP tool catalog that imports it — goes through here instead.
 *
 * The editor ALWAYS re-reads Postgres after an event; the payload is only a cue.
 * A notification failure must never fail the write that triggered it.
 */

/** Who caused the change — lets the review dock badge agent vs. human edits. */
export type DocumentReviewActor = "agent" | "human";

/**
 * What an open editor is told. Each event is a hint to re-read the document's
 * suggestions and comment threads from Postgres — never the authoritative
 * payload itself.
 */
export type DocumentReviewEvent =
  | {
      type: "suggestion";
      suggestionId: string;
      action: "created" | "accepted" | "rejected" | "withdrawn";
      by: DocumentReviewActor;
    }
  | { type: "suggestions"; count: number; by: DocumentReviewActor }
  | {
      type: "comment";
      commentId: string;
      threadId: string;
      action: "created" | "reply" | "resolved" | "reopened";
      by: DocumentReviewActor;
    }
  | { type: "document"; revision: number; by: DocumentReviewActor };

/** The one method the room exposes to the rest of the worker. */
interface DocumentReviewRoomStub {
  publish(event: DocumentReviewEvent): Promise<void> | void;
}

/**
 * Tell the editors watching `docId` that a review object changed. Best-effort:
 * swallows every failure so a live-update hiccup can never fail the persisted
 * write that triggered it.
 *
 * @param env - Worker bindings (reads the optional `DOCUMENT_REVIEW` namespace).
 * @param docId - The document UUID, used as the room's stable name.
 * @param event - The cue to broadcast to every connected editor.
 * @returns Nothing; resolves even when the namespace is unbound.
 * @example
 * await notifyReviewRoom(env, docId, {
 *   type: "suggestion", suggestionId, action: "created", by: "agent",
 * });
 */
export async function notifyReviewRoom(
  env: Env,
  docId: string,
  event: DocumentReviewEvent,
): Promise<void> {
  try {
    const ns = (env as unknown as { DOCUMENT_REVIEW?: DurableObjectNamespace }).DOCUMENT_REVIEW;
    if (!ns) return;
    await (ns.get(ns.idFromName(docId)) as unknown as DocumentReviewRoomStub).publish(event);
  } catch {
    /* live updates are a convenience, never a dependency */
  }
}
