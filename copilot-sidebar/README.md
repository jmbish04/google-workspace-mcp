# Copilot sidebar (Apps Script) — iframe model

The editor sidebar is a **thin iframe** that embeds the worker's copilot page. The
worker serves the whole UI (and can be upgraded to the built shadcn page); GAS
just wraps it and passes context.

## Flow
1. User opens **Copilot → Open Chat** in Docs/Sheets/Slides.
2. `Code.gs` reads the **active file id + host type** and calls
   `POST /api/copilot/token` (server-side, `WORKER_API_KEY`). The **worker returns
   the COMPLETE iframe URL** (`{ url }`) — it decides the page, token, and params.
3. `Code.gs` drops that `url` straight into `<iframe src="{url}">` — it builds
   nothing itself. The worker can route to different source pages by document
   type / task / flag entirely server-side.
4. The worker page chats via `POST /api/copilot/chat` (same-origin, bearer = the
   short token). Because `fileId`/`hostType` are baked into the URL + token, the
   copilot is **aware of the exact document** — "edit this doc" targets that file.

## Why a token (not the API key) in the URL
`Code.gs` mints a **short-lived, KV-backed token** (1h TTL) scoped to the account
+ file. The raw `WORKER_API_KEY` stays in Script Properties and never appears in
the iframe URL / browser history.

## Setup
1. Apps Script project with `Code.gs`. **Script Properties:**
   - `WORKER_URL` = `https://google-workspace-mcp.hacolby.workers.dev`
   - `WORKER_TOKEN` = the worker's `WORKER_API_KEY`
2. Reload the editor → **Copilot → Open Chat**.

## Worker endpoints (live on branch feat/oauth-only-tags-email-tracking, PR #20)
- `POST /api/copilot/token`  (Bearer WORKER_API_KEY) `{ account?, fileId?, hostType?, task? }` → **`{ url, token, expiresIn }`** — `url` is the authoritative iframe src (server-decided).
- `POST /api/copilot/chat`   (Bearer token OR WORKER_API_KEY) `{ messages, fileId?, hostType?, account? }` → `{ reply, account, steps }`
- `GET  /api/copilot/page`   → the copilot HTML (iframe target); the server can swap this per host/task behind the same session URL.

`/chat` runs the orchestrator's full Workspace tool set (multi-step). When `fileId`
is present, the system prompt tells the copilot it's attached to that file.

## Notes
- **Gmail** can't iframe HTML — the Gmail surface of the add-on stays CardService.
  Same project, cards in Gmail, iframe sidebar in editors.
- The `/api/copilot/page` is a functional vanilla page today; upgrade path is the
  built **shadcn** copilot page (the shared Vite+shadcn framework in
  core-template-gas, or the worker frontend), swapped in behind the same URL.
- One deploy-time check: Google's HtmlService iframe CSP must allow the nested
  worker iframe (standard, but verify on first install).
