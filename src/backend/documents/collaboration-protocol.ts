import type * as Y from "yjs";

/**
 * @fileoverview Pure codecs for the standard y-websocket binary protocol.
 *
 * Keeping framing outside the Durable Object makes sync and awareness behavior
 * directly testable in Node while the room remains a thin Cloudflare adapter.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_QUERY_AWARENESS = 3;

/** @param doc - Target Y.Doc. @returns A framed y-websocket sync-step-1 message. */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/**
 * Apply a framed sync message and encode any protocol reply.
 * @param doc - Durable room Y.Doc.
 * @param frame - Full y-websocket binary frame.
 * @param origin - Transaction origin used to avoid echoing to the sender.
 * @returns Reply frame, or undefined when no reply is required.
 * @throws When the frame is not a sync message.
 */
export function applySyncFrame(
  doc: Y.Doc,
  frame: Uint8Array,
  origin: unknown,
): Uint8Array | undefined {
  const decoder = decoding.createDecoder(frame);
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC)
    throw new Error("Expected y-websocket sync frame");
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.readSyncMessage(decoder, encoder, doc, origin);
  const reply = encoding.toUint8Array(encoder);
  return reply.length > 1 ? reply : undefined;
}

/** @param awareness - Room presence state. @param clientIds - Clients to encode. @returns Framed awareness update. */
export function encodeAwarenessFrame(
  awareness: awarenessProtocol.Awareness,
  clientIds: number[],
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds),
  );
  return encoding.toUint8Array(encoder);
}

/** @param update - Raw awareness update payload. @returns Client IDs carried by the update. */
export function readAwarenessClientIds(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }
  return ids;
}
