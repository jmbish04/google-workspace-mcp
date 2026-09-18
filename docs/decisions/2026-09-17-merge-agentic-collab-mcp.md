# Merge the Agentic Collaboration branch into google-workspace-mcp?

- **Date raised:** 2026-09-17
- **Raised by:** core-resumes session executing the Agentic Collaboration plans (plan 2: google-workspace-mcp)
- **Status:** awaiting decision

## What happened

Branch `feat/agentic-collab-mcp` is built, reviewed and green. It adds what the
core-resumes Documents tab needs so an agent can edit your Google files live:

1. **A Passcode door.** `/mcp` accepts the Passcode as a bearer credential, and
   the OAuth page offers "Passcode" beside "Sign in with Google". Either issues a
   one-year grant bound to your default Workspace account.
2. **`docs_edit_text`.** Replaces one occurrence of some text and keeps its
   formatting. It writes nothing and explains itself when the match mixes styles,
   contains something other than text (a footnote marker, an image, a chip), or
   carries a pending suggestion. It throws on a paragraph break or a missing tab.
   Each write is pinned to the document revision it read, so a document edited
   mid-flight rejects the write instead of deleting the wrong words.
3. **`sheets_update_values`.** Writes cell values only, leaving formatting,
   conditional formatting and data validation alone, with a `RAW` option so text
   from an untrusted source cannot land in a sheet as a live formula.
4. **A Preserve / Redesign / Clarify editing policy**, delivered in the server's
   opening handshake so every connecting agent reads it, and in AGENTS.md.

12 commits, 468 tests passing (up from 405), typecheck clean, lint unchanged.
Seven tasks, each reviewed; a whole-branch review and a scoped re-review after
the fixes. Three reviews each found a real write-safety bug, all fixed:

- an edit could delete unrelated text if the document changed between read and
  write;
- an edit could silently delete a footnote or inline image inside the match;
- an edit could silently resolve someone's pending suggestion.

## Why it matters

Merging is what puts this on the shared server your claude.ai connectors and your
other agents already use, and these tools write to your real documents. Two
things are worth your attention before it goes in.

**1. Anyone who can complete Google sign-in can act as your Workspace account.**
This is pre-existing, not introduced by this branch: registration is open, the
OAuth page is public, nothing restricts which Google account may complete a
sign-in, and every tool takes an `as_user` argument that is an unrestricted
email. The branch makes it matter more, because it adds write tools and a page
that advertises Google sign-in. How exposed you actually are depends on one
setting I cannot read from here: your Google Cloud OAuth consent screen for this
client. If it is **Internal**, or External with a fixed test-user list, the
exposure is limited to your own domain and this is fine for a single-user server.
If it is **External / In production**, any Google account on the internet can
mint a grant today, and this should be fixed before the deploy.

The Passcode door does not have this problem: it only works if you know the
Passcode, and it is now restricted to claude.ai and local addresses so a crafted
link cannot collect it.

**2. A one-line fallback change makes about 30 previously-failing paths run.**
`GOOGLE_WORKSPACE_ACCOUNT_EMAIL` and `GOOGLE_USER_TO_IMPERSONATE` are both empty
strings in the deployed config, which used to make every default-account call
throw "no stored OAuth credentials". They now fall back to `justin@126colby.com`
and actually execute, which is the intended fix. One specific consequence:
`"personal"` used to throw and now resolves to your consumer Gmail account, so
paths that name it reach a different mailbox than before.

## The question

Do you want me to open the pull request and merge this branch, and is your Google
OAuth consent screen for this client Internal or public?

## Options

1. **Confirm the consent screen is Internal, then merge and deploy.** I open the
   PR with all of this in the description, merge once CI is green, then run the
   manual Deploy workflow and the live checks: the Passcode and Google doors, a
   formatting-preserving edit on a real document, an edit against a document with
   a pending suggestion, a `RAW` sheet write, and a deliberate mid-edit change to
   confirm the revision guard rejects it. About 30 minutes.
   *(recommended — the branch is reviewed and green, and the one open risk is
   pre-existing and settled by a setting you can read in a few seconds)*
2. **Merge, but restrict `as_user` first.** I add an allowlist so a caller may
   only act as accounts you name, then merge. This closes the escalation path
   regardless of the consent screen, and it is the right end state either way. It
   costs an extra build-and-review cycle, roughly an hour, and it may break any
   existing caller that passes an account outside the list.
3. **Hold.** Nothing merges, nothing deploys. The core-resumes Documents tab work
   (plan 3, 17 tasks) stays blocked, because it calls these tools.

## Default if no answer

Hold. Nothing is pushed, merged or deployed, and no account settings change. The
branch sits in its worktree, and the work stays where it is.

## Decision

_(empty until answered)_
