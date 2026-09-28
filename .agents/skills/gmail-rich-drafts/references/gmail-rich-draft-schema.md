# gmail_create_draft rich composition schema

## attachments array

Each attachment is ONE of:

### Drive file (attach)
```json
{ "driveFileId": "string" }
```
Downloads and attaches. Respects 25 MiB budget; over-limit falls back to Drive link.

### Drive file (force link)
```json
{ "driveFileId": "string", "as": "link" }
```
Skips download; creates shared Drive link in email body.

### Drive file (inline image)
```json
{ "driveFileId": "string", "as": "inline", "contentId": "string" }
```
Downloads and embeds with `Content-ID`. Reference: `<img src="cid:contentId">`. Always attaches.

### Blob (attach)
```json
{ "blob": "base64", "filename": "string", "mimeType": "string (optional)" }
```
Attaches base64 blob; counts toward budget.

### Blob (inline image)
```json
{ "blob": "base64", "filename": "string", "mimeType": "string (optional)", "as": "inline", "contentId": "string" }
```
Embeds base64 blob with Content-ID. Reference: `<img src="cid:contentId">`.

## recipients normalization

`to`, `cc`, `bcc` accept single email, array, or comma-separated string. All normalized to RFC 2822 format by `addrList()`.

## MIME nesting

Automatic based on content:
```
multipart/mixed                    (only if file attachments)
├─ multipart/related              (only if inline images)
│  ├─ multipart/alternative
│  │  ├─ text/plain
│  │  └─ text/html (inlined CSS)
│  └─ image parts (Content-ID, inline)
└─ file attachment parts
```
