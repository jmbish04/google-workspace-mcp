/**
 * @file documents/review-room.ts
 * @description One Durable Object per document, used only as a live cue hub for
 * REVIEW OBJECTS (suggestions and comments) — the suggestion/comment analogue of
 * the draft-studio {@link file://../gmail/draft-room.ts} room. When an MCP tool
 * drops a suggestion or comment (or applies one), every editor the human has
 * open updates its review dock without a refresh.
 *
 * It deliberately holds NO authoritative state — Postgres is the record, and
 * every event is a cue to re-read it. That keeps the socket cheap, means a page
 * that missed an event while offline is corrected by its next fetch, and makes
 * the whole feature degrade to "press refresh" rather than to wrong content if
 * the DO is unreachable.
 *
 * This is NOT Phase 3's `DocumentCollaborationRoom` (collaboration-room.ts): that
 * is a stateful Yjs CRDT room syncing the document BODY over binary frames.
 * Suggestions/comments live in Postgres, not the Y.Doc, and a Yjs socket rejects
 * the JSON cue — so this is a separate, complementary channel, mirroring the
 * stateless draft-studio pattern rather than inventing a parallel body-sync path.
 *
 * Uses the Hibernatable WebSockets API (`ctx.acceptWebSocket`), so an open editor
 * costs nothing while nobody is editing.
 */
import { DurableObject } from "cloudflare:workers";

import type { DocumentReviewEvent } from "./review-notify";

export type { DocumentReviewEvent } from "./review-notify";

/** Live cue hub for one document's suggestions and comments. Keyed by document UUID. */
export class DocumentReviewRoom extends DurableObject<Env> {
  /** Upgrade an incoming request to a hibernatable WebSocket on this room. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Fan a cue out to every editor watching this document.
   * @param event - The change cue; editors re-read Postgres on receipt.
   */
  publish(event: DocumentReviewEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* a dead socket must not stop the others */
      }
    }
  }

  /** The client's keepalive. Nothing else is accepted from the browser. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
}
