/**
 * @file gmail/draft-room-notify.ts
 * @description How the rest of the worker tells an open draft-studio page that
 * something changed.
 *
 * Deliberately separate from `draft-room.ts`: that module imports
 * `cloudflare:workers` for the Durable Object base class, which only resolves
 * inside workerd. Everything that merely NOTIFIES — the studio service, and so
 * the whole MCP tool catalog that imports it — goes through here instead, so
 * the import graph of ordinary code never reaches the runtime-only module.
 */

/** What the page is told. It always re-reads D1; the payload is just a hint. */
export type DraftRoomEvent =
  | { type: "revision"; n: number; source: "agent" | "human"; note?: string | null }
  | { type: "comment"; commentId: string }
  | { type: "status"; status: string };

/** The one method the room exposes to the rest of the worker. */
interface DraftRoomStub {
  publish(event: DraftRoomEvent): Promise<void> | void;
}

/**
 * Tell the open pages something changed. Best-effort: a notification failure
 * must never fail the write that triggered it — the data is already in D1 and
 * the page's own fetch will correct it.
 */
export async function notifyDraftRoom(env: Env, draftId: string, event: DraftRoomEvent): Promise<void> {
  try {
    const ns = (env as unknown as { EMAIL_DRAFT_ROOM?: DurableObjectNamespace }).EMAIL_DRAFT_ROOM;
    if (!ns) return;
    await (ns.get(ns.idFromName(draftId)) as unknown as DraftRoomStub).publish(event);
  } catch {
    /* live updates are a convenience, never a dependency */
  }
}
