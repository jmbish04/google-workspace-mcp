/**
 * @fileoverview Live updates for an open studio draft.
 *
 * The socket only ever carries "something changed" hints — the hook responds by
 * re-reading the draft over REST, so a dropped or missed message costs one
 * stale render at worst, never wrong content. It reconnects with backoff while
 * the page is open and closes on unmount, which is what the user means by
 * "the socket is only live when the page is open".
 */

import * as React from "react";

export type SocketState = "connecting" | "live" | "offline";

export function useDraftSocket(draftId: string, onChange: () => void): SocketState {
  const [state, setState] = React.useState<SocketState>("connecting");
  // Keep the latest callback without re-opening the socket on every render.
  const handler = React.useRef(onChange);
  handler.current = onChange;

  React.useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      if (closed) return;
      setState(retry === 0 ? "connecting" : "offline");
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${scheme}://${window.location.host}/api/email-drafts/${draftId}/ws`);

      ws.onopen = () => {
        retry = 0;
        setState("live");
        // A periodic ping keeps intermediaries from dropping an idle socket.
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 45_000);
      };
      ws.onmessage = (ev) => {
        if (ev.data !== "pong") handler.current();
      };
      ws.onclose = () => {
        if (ping) clearInterval(ping);
        if (closed) return;
        setState("offline");
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry, 30_000));
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ping) clearInterval(ping);
      ws?.close();
    };
  }, [draftId]);

  return state;
}
