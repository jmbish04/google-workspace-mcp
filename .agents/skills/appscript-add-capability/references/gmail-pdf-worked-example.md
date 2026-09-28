# gmail-to-pdf: Worked Example of appscript-add-capability

This documents the gmail-to-pdf feature added to google-workspace-mcp standing scripts, showing each component of the capability pattern.

## Files Created

### 1. Vendor Module (src/backend/appscript-templates/gmail-pdf/vendor.ts)

Encodes pixelcog/gmail-to-pdf sources (GmailUtils.gs 528 lines, DriveUtils.gs 21 lines) as base64:

```typescript
const GMAIL_UTILS_B64 = "SGVs..."; // 24,764 chars
const DRIVE_UTILS_B64 = "..."; // 724 chars

const decode = (b64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));

export const GMAIL_UTILS_GS = decode(GMAIL_UTILS_B64);
export const DRIVE_UTILS_GS = decode(DRIVE_UTILS_B64);
```

**Verification**: Decoded sources contain `function messageToPdf` and `function getFolder` ✓

### 2. Capability Template (src/backend/appscript-templates/gmail-pdf/index.ts)

Exports the entry point, scopes, and builder:

```typescript
export const GMAIL_PDF_ENTRY = "exportEmailPdf";

export const GMAIL_PDF_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/script.external_request",
];

const GMAIL_PDF_ENTRY_GS = `
function exportEmailPdf(threadId, messageIds, opts) {
  opts = opts || {};
  var messages = messageIds && messageIds.length
    ? messageIds.map(id => GmailApp.getMessageById(id))
    : threadId ? GmailApp.getThreadById(threadId).getMessages() : [];
  if (!messages.length) throw 'exportEmailPdf: provide threadId or messageIds';
  
  var subject = messages[messages.length - 1].getSubject() || 'email';
  var name = String(opts.filename || subject).replace(/[^\\w.-]+/g, '_') + '.pdf';
  
  var pdf = messageToPdf(messages, { width: opts.width || 700 }).setName(name);
  var folder = getFolder(opts.folder || 'MCP Email PDFs');
  var file = folder.createFile(pdf);
  return { fileId: file.getId(), url: file.getUrl(), name: name, messages: messages.length, subject: subject };
}
`;

export function buildGmailPdfFiles(): ScriptFile[] {
  return [
    { name: "GmailUtils", type: "SERVER_JS", source: GMAIL_UTILS_GS },
    { name: "DriveUtils", type: "SERVER_JS", source: DRIVE_UTILS_GS },
    { name: "GmailPdfExport", type: "SERVER_JS", source: GMAIL_PDF_ENTRY_GS },
  ];
}
```

### 3. Install Helper (src/backend/appscript/gmail-pdf-install.ts)

Merges files and **union-merges OAuth scopes**:

```typescript
export async function installGmailPdf(
  env: Env,
  ref: string,
  scriptId: string,
  account?: string,
): Promise<DeployResult> {
  const svc = new AppsScriptService(env, ref);
  const content = (await svc.getContent(scriptId)) as { files?: AppsScriptFile[] };
  const files: AppsScriptFile[] = content.files ?? [];

  // Read existing manifest
  const manifestFile = files.find(f => f.name === "appsscript");
  let manifest: Record<string, unknown> = {};
  try {
    manifest = manifestFile ? JSON.parse(manifestFile.source) : {};
  } catch {
    manifest = {};
  }

  // Union-merge scopes: preserve existing, add new, deduplicate
  const existingScopes = Array.isArray(manifest.oauthScopes) ? (manifest.oauthScopes as string[]) : [];
  manifest.oauthScopes = [...new Set([...existingScopes, ...GMAIL_PDF_SCOPES])];
  
  // Re-stringify manifest
  const mergedManifest: AppsScriptFile = {
    name: "appsscript",
    type: "JSON",
    source: JSON.stringify(manifest, null, 2),
  };

  // Deploy merged manifest + new files
  return deployMergedVersion(env, ref, {
    scriptId,
    newFiles: [mergedManifest, ...buildGmailPdfFiles()],
    useCase: "gmail-pdf",
    description: "Install gmail-to-pdf export (pixelcog)",
    account,
  });
}
```

**Key line**: `manifest.oauthScopes = [...new Set([...existingScopes, ...GMAIL_PDF_SCOPES])]`
- Spreads existing scopes (if manifest has none, array is empty)
- Adds GMAIL_PDF_SCOPES (3 new scopes)
- Wraps in Set to deduplicate (in case Docs/Sheets already added them)
- Spreads back to array

This prevents silent breakage: if Docs or Sheets already added a scope, it is preserved; no naked overwrite that would drop it.

### 4. MCP Tool (src/backend/mcp/tools.ts)

Registers the install tool:

```typescript
{
  name: "appsscript_install_gmail_pdf",
  description: "Install the native 'email → Drive PDF' capability...",
  inputSchema: z.object({ ...asUser }),
  async run({ env, sub }, a) {
    const ref = acct(sub, a);
    const email = (a.as_user ?? (await accountEmailFor(env, ref))).toLowerCase();
    const scriptId = await resolveStandingScript(env, email);
    if (!scriptId) {
      throw new Error(`No standing Apps Script registered for ${email}...`);
    }
    const res = await installGmailPdf(env, ref, scriptId, email);
    return {
      result: { ...res, entry: GMAIL_PDF_ENTRY, account: email },
      asset: { assetType: "script", googleId: scriptId, action: "modify", detail: { installed: "gmail-pdf" } },
    };
  },
}
```

## How It Worked

1. **Vendor**: Fetched pixelcog sources, encoded as base64, verified round-trip
2. **Template**: Exported ENTRY, SCOPES, builder in one module
3. **Install**: Read manifest, union-merged scopes (preserved existing), called deployMergedVersion
4. **Tool**: Resolved account's standing script, ran install, returned result
5. **Verify**: TypeCheck 0 errors, 348 tests pass

## Deployment Flow (For Next Session)

When installing gmail-to-pdf into an account:

1. Call `appsscript_install_gmail_pdf` with `as_user: account@example.com`
2. Helper reads standing script, merges files + scopes, redeploys
3. If prompted: project owner re-authorizes (new scopes may require consent)
4. Then `gmail_to_pdf` with `via: "appscript"` saves PDF to user's Drive, returns permanent URL

## Lessons for Next Capability

When adding gmail-to-sheets, email-summarize, or any other feature:

- **Copy the vendor pattern** if the library has backticks/regex
- **Copy the /appscript-templates structure** — one module per capability
- **Copy the install helper** — rename GMAIL_PDF → feature name, same scope union logic
- **Copy the tool** — rename appsscript_install_gmail_pdf → appsscript_install_[feature]
- **The scope union is mandatory** — never overwrite manifest.oauthScopes