/**
 * @fileoverview Regression tests for y-websocket sync and awareness framing.
 *
 * These tests fail if the provider stops applying encoded offline updates or
 * loses the client IDs needed to clean up presence on disconnect.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import {
  applySyncFrame,
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
  readAwarenessClientIds,
} from "@/backend/documents/collaboration-protocol";

describe("collaboration protocol", () => {
  it("applies a framed offline Y.Doc update to the room document", () => {
    const offline = new Y.Doc();
    offline.getText("content").insert(0, "offline merge");
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(offline));
    const room = new Y.Doc();

    applySyncFrame(room, encoding.toUint8Array(encoder), "socket-1");

    expect(room.getText("content").toString()).toBe("offline merge");
  });

  it("extracts every awareness client id for disconnect cleanup", () => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState({ user: { name: "Codex" } });
    const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]);
    const frame = encoding.createEncoder();
    encoding.writeVarUint(frame, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(frame, update);
    const decoder = decoding.createDecoder(encoding.toUint8Array(frame));
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_AWARENESS);
    expect(readAwarenessClientIds(decoding.readVarUint8Array(decoder))).toEqual([doc.clientID]);
  });
});
