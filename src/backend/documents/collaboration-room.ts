/**
 * @fileoverview Durable Yjs collaboration room using the y-websocket protocol.
 *
 * One SQLite-backed Durable Object is addressed per document UUID. It persists
 * every encoded Y.Doc update, compacts the log into a snapshot, and supports
 * the standard sync, awareness, and awareness-query message types expected by
 * `y-websocket` and Tiptap's collaboration extensions. WebSockets use the
 * Cloudflare Hibernation API; awareness client IDs are stored as attachments
 * so presence can be removed correctly after eviction and disconnect.
 */
import { DurableObject } from "cloudflare:workers";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import {
  applySyncFrame,
  encodeAwarenessFrame,
  encodeSyncStep1,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
  readAwarenessClientIds,
} from "@/backend/documents/collaboration-protocol";
const COMPACT_AFTER_UPDATES = 100;

type SocketAttachment = { clientIds: number[]; awarenessUpdate?: Uint8Array };

/** A persisted, per-document Yjs collaboration room. */
export class DocumentCollaborationRoom extends DurableObject<Env> {
  private readonly doc = new Y.Doc();
  private readonly awareness = new awarenessProtocol.Awareness(this.doc);

  /**
   * Initialize storage and rebuild the Y.Doc before accepting events.
   * @param ctx - Durable Object state and hibernating socket coordinator.
   * @param env - Generated Worker bindings.
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS y_updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, update_blob BLOB NOT NULL, created_at INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS y_snapshot (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_blob BLOB NOT NULL, updated_at INTEGER NOT NULL)",
      );
      const snapshot = this.ctx.storage.sql
        .exec<{ state_blob: ArrayBuffer }>("SELECT state_blob FROM y_snapshot WHERE singleton = 1")
        .toArray()[0];
      if (snapshot) Y.applyUpdate(this.doc, new Uint8Array(snapshot.state_blob), "storage");
      for (const row of this.ctx.storage.sql
        .exec<{ update_blob: ArrayBuffer }>("SELECT update_blob FROM y_updates ORDER BY seq")
        .toArray())
        Y.applyUpdate(this.doc, new Uint8Array(row.update_blob), "storage");
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as SocketAttachment | null;
        if (attachment?.awarenessUpdate)
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            attachment.awarenessUpdate,
            "hibernation-restore",
          );
      }
      this.doc.on("update", (update, origin) => this.persistAndBroadcast(update, origin));
      this.awareness.on(
        "update",
        (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) =>
          this.broadcastAwareness(
            [...changes.added, ...changes.updated, ...changes.removed],
            origin,
          ),
      );
    });
  }

  /**
   * Upgrade a request and immediately send sync step 1 plus current presence.
   * @param request - WebSocket upgrade request proxied by the Worker.
   * @returns A 101 response or 426 for non-WebSocket requests.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ clientIds: [] } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);

    server.send(encodeSyncStep1(this.doc));
    this.sendAwareness(server, [...this.awareness.getStates().keys()]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Process one standard y-websocket binary frame.
   * @param socket - Sending WebSocket.
   * @param message - Binary protocol frame.
   * @returns Nothing.
   */
  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === "string") {
      socket.close(1003, "Binary Yjs frames required");
      return;
    }
    const decoder = decoding.createDecoder(new Uint8Array(message));
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const reply = applySyncFrame(this.doc, new Uint8Array(message), socket);
      if (reply) socket.send(reply);
      return;
    }
    if (messageType === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      const attachment = (socket.deserializeAttachment() as SocketAttachment | null) ?? {
        clientIds: [],
      };
      socket.serializeAttachment({
        clientIds: [...new Set([...attachment.clientIds, ...readAwarenessClientIds(update)])],
        awarenessUpdate: update,
      } satisfies SocketAttachment);
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, socket);
      return;
    }
    if (messageType === MESSAGE_QUERY_AWARENESS) {
      this.sendAwareness(socket, [...this.awareness.getStates().keys()]);
      return;
    }
    socket.close(1003, "Unsupported y-websocket message");
  }

  /**
   * Remove the disconnected client's ephemeral awareness state.
   * @param socket - Closing WebSocket.
   * @param code - WebSocket close code.
   * @param reason - WebSocket close reason.
   * @returns Nothing.
   */
  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.clientIds.length)
      awarenessProtocol.removeAwarenessStates(this.awareness, attachment.clientIds, socket);
    socket.close(code, reason);
  }

  /** @param socket - Failed WebSocket. @param error - Runtime error. @returns Nothing. */
  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    console.error(
      JSON.stringify({
        service: "yjs-collaboration",
        event: "websocket_error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    socket.close(1011, "Collaboration error");
  }

  /** @returns Persistent update count and active connection count. */
  async health(): Promise<{ status: "ok"; updates: number; connections: number }> {
    const row = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM y_updates")
      .one();
    return { status: "ok", updates: row.count, connections: this.ctx.getWebSockets().length };
  }

  private persistAndBroadcast(update: Uint8Array, origin: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO y_updates (update_blob, created_at) VALUES (?, ?)",
      update,
      Date.now(),
    );
    const count = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM y_updates")
      .one().count;
    if (count >= COMPACT_AFTER_UPDATES) {
      const snapshot = Y.encodeStateAsUpdate(this.doc);
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO y_snapshot (singleton, state_blob, updated_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET state_blob = excluded.state_blob, updated_at = excluded.updated_at",
          snapshot,
          Date.now(),
        );
        this.ctx.storage.sql.exec("DELETE FROM y_updates");
      });
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(encoding.toUint8Array(encoder), origin);
    console.info(
      JSON.stringify({
        service: "yjs-collaboration",
        event: "update_persisted",
        bytes: update.byteLength,
        connections: this.ctx.getWebSockets().length,
      }),
    );
  }

  private broadcastAwareness(clientIds: number[], origin: unknown): void {
    if (clientIds.length === 0) return;
    this.broadcast(encodeAwarenessFrame(this.awareness, clientIds), origin);
  }

  private sendAwareness(socket: WebSocket, clientIds: number[]): void {
    if (clientIds.length === 0) return;
    socket.send(encodeAwarenessFrame(this.awareness, clientIds));
  }

  private broadcast(message: Uint8Array, origin: unknown): void {
    for (const socket of this.ctx.getWebSockets())
      if (socket !== origin && socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}
