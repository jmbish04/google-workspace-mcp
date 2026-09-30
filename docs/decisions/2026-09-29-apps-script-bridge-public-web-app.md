# Should the Apps Script bridge be a public Web App guarded by a key?

- **Date raised:** 2026-09-29
- **Raised by:** google-workspace-mcp-worker-22eaa3 (gmail HTML drafts session)
- **Status:** decided

## What happened
The goal is to have Apps Script do Workspace work for the Worker, because a script's
authorization does not lapse the way the Worker's Google login does. I built the
`workspace-bridge` Apps Script project in core-template-gas (branch
`feat/workspace-bridge`). It handles Gmail HTML drafts (create, update, get, list)
and cleans Google Docs without breaking their formatting. Tests pass.

The design follows tanaikech/adk-gas. It only escapes the lapsing login if the Web
App is deployed as **"Execute as: Me, Who has access: Anyone"**, and it then checks
a shared key itself. The alternatives, "access: Only me" or the Execution API
(`scripts.run`), both need a Google OAuth token from the Worker, which is the thing
that lapses.

The repo's shared manifest forces every Web App to "Only me". My change added an
opt-out, declared in each project's `project.json`, and the safety classifier
blocked it as weakening security. It is not applied.

## Why it matters
Without the opt-out, the bridge is still built and tested, but it cannot remove the
dependency on the Worker's login. That dependency was the main point of the work.
The HTML drafts and the authorship watermark do **not** depend on this decision.
They already work through the Worker's existing Gmail API path.

## The question
Do you approve deploying `workspace-bridge` as a public Web App ("Anyone") that
rejects every request lacking the correct key?

## What the "Anyone" exposure actually is
- Anyone who knows the long, random `/exec` URL can reach the endpoint.
- Every request is rejected unless its body carries the key. The script compares a
  SHA-256 of the key in constant time against a hash stored in the script's
  properties.
- A bridge that has not been set up rejects everything. It is never open by default.
- The key travels in the POST body, never in the URL, so it does not end up in logs.
- **Weak point:** `WORKER_API_KEY` is short. I measured 10 characters, all from one
  character class. Guessing it over HTTP is impractical because Apps Script caps
  executions per day. Even so, a longer key is the real fix.

## Options
1. **Approve "Anyone + key", and give the bridge its own long key.** *(recommended:
   it removes the lapse problem, and a dedicated 32-byte key makes guessing
   pointless.)* This mints one new credential, stored in the `tokens` CLI and a
   Secret Store slot. That departs from the rule that everything uses
   `WORKER_API_KEY`, so it is your call.
2. **Approve "Anyone + key", reusing `WORKER_API_KEY`.** Zero new credentials, but it
   relies on a short key.
3. **Keep "Only me" / `scripts.run`.** No public endpoint. The bridge's draft and
   Docs-cleanup actions are still usable, but they depend on the Worker's Google
   login, the same as today.

## Default if no answer
Option 3. Nothing public gets deployed. The watermarked HTML drafts ship through the
Worker's existing Gmail API path, and the bridge code waits on its branch.

## Decision
**Option 3: Execution API (`scripts.run`), no public Web App.** Decided 2026-09-30.

Justin: "The appscript should be able to run in google script execution api to run
a function, no? i just need to auth the appscript on its first run", followed by "go".

Measured 2026-09-30, before deciding: the Worker's own token read both accounts'
standing Apps Script projects successfully. The last lapses were `invalid_rapt`,
fixed by #25 (Cloud-free scopes). Google's docs say the Execution API runs as the
caller's token ("must cover all the scopes used by the script"), so the bridge stays
exactly as healthy as the Worker's login. Revisit the Web App only if
justin@126colby.com's token lapses again. The code change for that is small; it would
also need a dedicated long key.
