---
name: gmail-rich-drafts
description: Compose email drafts with multiple recipients, hyperlinks, inline images, and attachments via gmail_create_draft. Use when building multi-recipient drafts or embedding images/files in the email body using the richBody schema.
---

Compose email drafts with rich content: multiple recipients, hyperlinks, inline images, and file attachments via the `gmail_create_draft` tool's `richBody` schema.

**Recipients** — `to`, `cc`, `bcc` accept:
- Array: `["user1@example.com", "user2@example.com"]`
- Comma-separated string: `"user1@example.com, user2@example.com"`

**Links** — HTML or Markdown:
- HTML: `<a href="https://example.com">text</a>`
- Markdown: `[text](https://example.com)`

**Inline images** — Embed in HTML body with Content-ID:
- Add attachment: `{ blob: "<base64>", filename: "logo.png", mimeType: "image/png", as: "inline", contentId: "logo" }`
- Reference: `<img src="cid:logo">`
- Inline images always attach (never fall back to Drive links); count toward 25 MiB budget.

**File attachments** — Default behavior:
- `{ driveFileId: "..." }` → attach Drive file bytes
- `{ blob: "<base64>", filename: "...", mimeType: "..." }` → attach inline blob
- `{ driveFileId: "...", as: "link" }` → force shared Drive link
- Over ~18 MiB raw → auto-fall back overflow to Drive links

MIME structure is automatic: `multipart/mixed` (if files) > `multipart/related` (if inline images) > `multipart/alternative` (text + html). See `references/gmail-rich-draft-schema.md` for full schema and examples.