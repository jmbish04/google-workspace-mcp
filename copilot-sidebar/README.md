# Copilot sidebar (Apps Script)

A chat copilot that runs in the Google editor sidebar (Docs/Sheets/Slides/Gmail)
and drives the `google-workspace-mcp` worker's orchestrator — the domain-authority
agents across Gmail/Docs/Sheets/Slides/Drive/Apps Script/Calendar.

## Files
- `Code.gs` — adds the **Copilot** menu, opens the sidebar, injects the worker URL + token from Script Properties.
- `Sidebar.html` — CDN React + Tailwind chat UI (no build step). POSTs `{ messages }` to the worker and renders `{ reply }`.

## Setup
1. Create an Apps Script project (standalone, or container-bound to a Doc), add `Code.gs` + `Sidebar.html`.
2. **Script Properties** (Project Settings → Script Properties):
   - `WORKER_URL` = `https://google-workspace-mcp.hacolby.workers.dev`
   - `WORKER_TOKEN` = the worker's `WORKER_API_KEY`
3. Reload the editor → **Copilot → Open Chat**.

## How it talks to the worker
`POST {WORKER_URL}/api/copilot/chat`
- Header: `Authorization: Bearer {WORKER_TOKEN}`
- Body: `{ "messages": [{ "role": "user"|"assistant", "content": "…" }], "account"?: "workspace"|"personal"|email }`
- Returns: `{ "reply": "…", "account": "…", "steps": n }`

The endpoint runs the SAME tool set + system prompt as the OrchestratorAgent
(`buildWorkspaceToolSet`, `stepCountIs(16)`), request/response so a plain `fetch`
works from the sidebar. The token is injected server-side (Script Properties) at
render time and never committed.

## Notes / next steps
- **Request/response, not streamed.** The shadcn `MessageScroller`/`Marker`
  streaming affordances need an SSE/WebSocket path (worker token-issue + stream
  route) — a follow-up if you want live token streaming.
- To ship this via `core-template-gas` CI instead of a manual project, wrap it as
  a GAS project there (the CDN-React variant needs no esbuild build).
