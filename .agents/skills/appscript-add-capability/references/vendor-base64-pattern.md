# Vendoring Code with Base64 Encoding

## Problem

When vendoring a small library that contains backticks or complex regex patterns, hand-escaping for TypeScript template literals is error-prone and a vector for copy mistakes. Example:

```javascript
var pattern = new RegExp(/<(((([a-z]|\d|[!#\$%&'\*\+\-\/=\?\^_`{\|}~])...>/i);
```

Embedding this in a TypeScript template string requires careful escaping of each backtick and backslash. Hand-copying 500 lines is a guaranteed source of errors.

## Solution

Encode the entire source file(s) as base64. Store the base64 string as a TypeScript const, and decode at module load with `atob()` + `TextDecoder`:

```typescript
const SOURCE_B64 = "SGVsbG8gV29ybGQ..."; // base64-encoded source
const decode = (b64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
export const SOURCE_GS = decode(SOURCE_B64);
```

## Why it works

- **Zero escaping**: base64 is ASCII-safe; no special chars trigger template-literal conflicts
- **Zero hand-copy errors**: automate encoding/decoding; no manual transcription
- **Round-trip verifiable**: decode and grep for known functions to prove exact fidelity
- **Works with backtick-heavy code**: pixelcog/gmail-to-pdf has 2 backticks in regex patterns; base64 sidesteps all of it

## Example

pixelcog/gmail-to-pdf (GmailUtils.gs 528 lines + DriveUtils.gs 21 lines) was vendored into `gmail-pdf/vendor.ts`:

1. Fetch GmailUtils.gs and DriveUtils.gs from GitHub
2. Verify key functions exist (e.g. `grep 'function messageToPdf'`)
3. Encode both as base64
4. Emit vendor.ts with base64 consts + decode function
5. Verify round-trip: `decode(GMAIL_UTILS_B64).includes('function messageToPdf')` ✓

This took ~5 minutes and avoided any TypeScript escaping or template-literal issues.