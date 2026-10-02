/**
 * @file gmail/draft-room.ts
 * @description One Durable Object per studio draft, used only as a live
 * notification hub: when the agent pushes a revision or resolves a comment, the
 * page the human has open updates without a refresh.
 *
 * It deliberately holds NO authoritative state — D1 is the record, and every
 * event is a cue to re-read it. That keeps the socket cheap, means a page that
 * missed an event while offline is corrected by its next fetch, and makes the
 * whole feature degrade to "press refresh" rather than to wrong content if the
 * DO is unreachable.
 *
 * Uses the Hibernatable WebSockets API (`ctx.acceptWebSocket`), so an open page
 * costs nothing while nobody is typing.
 */
import { DurableObject } from "cloudflare:workers";

import type { DraftRoomEvent } from "./draft-room-notify";

export type { DraftRoomEvent } from "./draft-room-notify";

export class EmailDraftRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Fan an event out to every page watching this draft. */
  publish(event: DraftRoomEvent): void {
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

