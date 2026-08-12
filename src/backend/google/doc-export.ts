/**
 * @file google/doc-export.ts
 * @description Clean utility: export Google Docs to a file (PDF by default, or
 * any Drive-export format, or Markdown), save it beside the source doc, and
 * return the exported file's Drive id / view url / download url + a content hash
 * and the source's live modifiedTime (revision provenance).
 *
 * Operates ONLY on Drive ids or urls (single or array, freely mixed) — every
 * element is run through {@link parseDriveRefs}. Each ref is processed
 * independently (one failure never aborts the rest) and the doc may live in any
 * registered account (cross-account fallback, like sheet-export).
 *
 * Tabs: `tab` selects scope — "all" (default, whole document via Drive export in
 * the requested format), "first", or a specific tabId. Single-tab export is
 * built from the Docs API structure and is Markdown-only (Google has no native
 * per-tab PDF/binary export); requesting a single tab in another format is a
 * reported error, not a crash.
 */
import { parseDriveRefs } from "@/backend/google/core/ids";
import { convertDocsJsonToMarkdown } from "@/backend/google/core/markdown";
import { DriveService } from "@/backend/mcp/services/drive";
import { GoogleDocsClient } from "@/backend/google/docs";

const GDOC_MIME = "application/vnd.google-apps.document";

export type DocExportFormat = "pdf" | "markdown" | "docx" | "html" | "txt" | "odt" | "rtf" | "epub";

/** Drive-export mime + file extension per format. */
const FORMATS: Record<DocExportFormat, { mime: string; ext: string }> = {
  pdf: { mime: "application/pdf", ext: "pdf" },
  markdown: { mime: "text/markdown", ext: "md" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  html: { mime: "text/html", ext: "html" },
  txt: { mime: "text/plain", ext: "txt" },
  odt: { mime: "application/vnd.oasis.opendocument.text", ext: "odt" },
  rtf: { mime: "application/rtf", ext: "rtf" },
  epub: { mime: "application/epub+zip", ext: "epub" },
};

export interface ExportAccount {
  email: string;
  ref: string;
}

export interface DocExportResult {
  requested: string;
  documentId: string;
  status: "done" | "error";
  sourceAccount?: string;
  triedAccounts: string[];
  format: DocExportFormat;
  /** "all" | "first" | a tabId. */
  tabScope: string;
  exportDriveId?: string;
  exportDriveUrl?: string;
  exportDownloadUrl?: string;
  exportSha256?: string;
  sourceModifiedTime?: string;
  error?: string;
}

function safeName(s: string): string {
  return (s || "document").replace(/[^\w.-]+/g, "_").slice(0, 120);
}

function downloadUrl(fileId: string): string {
  return `https://drive.google.com/uc?id=${fileId}&export=download`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A tab flattened out of the nested Docs `tabs[]` tree. */
interface FlatTab {
  tabId: string;
  title: string;
  body: unknown;
}

interface RawDocWithTabs {
  body?: unknown;
  tabs?: RawTab[];
}
interface RawTab {
  tabProperties?: { tabId?: string; title?: string };
  documentTab?: { body?: unknown };
  childTabs?: RawTab[];
}

function flattenTabs(tabs: RawTab[]): FlatTab[] {
  const out: FlatTab[] = [];
  const walk = (t: RawTab): void => {
    out.push({
      tabId: t.tabProperties?.tabId ?? "",
      title: t.tabProperties?.title ?? "",
      body: t.documentTab?.body,
    });
    for (const c of t.childTabs ?? []) walk(c);
  };
  for (const t of tabs) walk(t);
  return out;
}

/** Build Markdown for a single requested tab ("first" or a tabId). Throws if not found. */
function singleTabMarkdown(doc: RawDocWithTabs, tab: string): string {
  const tabs = flattenTabs(doc.tabs ?? []);
  if (tabs.length === 0) {
    // Doc has no tabs — treat the whole body as the one tab.
    return convertDocsJsonToMarkdown({ body: doc.body });
  }
  const selected = tab === "first" ? tabs[0] : tabs.find((t) => t.tabId === tab);
  if (!selected) {
    throw new Error(`Tab "${tab}" not found. Available tabIds: ${tabs.map((t) => t.tabId).join(", ") || "(none)"}`);
  }
  return convertDocsJsonToMarkdown({ body: selected.body });
}

async function exportOne(
  env: Env,
  accounts: ExportAccount[],
  requested: string,
  documentId: string,
  format: DocExportFormat,
  tab: string,
): Promise<DocExportResult> {
  const tried: string[] = [];
  let lastError = "no registered account could access this document";
  const base: Pick<DocExportResult, "requested" | "documentId" | "format" | "tabScope"> = {
    requested,
    documentId,
    format,
    tabScope: tab,
  };

  for (const account of accounts) {
    tried.push(account.email);
    try {
      const drive = new DriveService(env, account.ref);
      const meta = await drive.get(documentId); // validates access + gives name/mimeType
      if (meta.mimeType !== GDOC_MIME) {
        throw new Error(`Not a Google Doc (mimeType ${meta.mimeType}). Use sheets_export_json for spreadsheets.`);
      }
      const { parents, modifiedTime } = await drive.getLocationInfo(documentId);

      let bytes: Uint8Array;
      let mime: string;
      let ext: string;
      let nameSuffix = "";

      if (tab === "all") {
        const f = FORMATS[format];
        bytes = await drive.exportBinary(documentId, f.mime); // whole document, all tabs
        mime = f.mime;
        ext = f.ext;
      } else {
        if (format !== "markdown") {
          throw new Error(
            `Single-tab export ("${tab}") is Markdown-only (Google has no native per-tab ${format} export). Use format:"markdown", or tab:"all".`,
          );
        }
        const docs = new GoogleDocsClient(env, account.ref);
        const doc = await docs.getWithTabs<RawDocWithTabs>(documentId);
        bytes = new TextEncoder().encode(singleTabMarkdown(doc, tab));
        mime = "text/markdown";
        ext = "md";
        nameSuffix = tab === "first" ? ".first-tab" : `.tab-${safeName(tab)}`;
      }

      const exportSha256 = await sha256Hex(bytes);
      const uploaded = await drive.uploadBinary(`${safeName(meta.name)}${nameSuffix}.${ext}`, mime, bytes, parents[0]);

      return {
        ...base,
        status: "done",
        sourceAccount: account.email,
        triedAccounts: tried,
        exportDriveId: uploaded.id,
        exportDriveUrl: uploaded.webViewLink ?? `https://drive.google.com/file/d/${uploaded.id}/view`,
        exportDownloadUrl: downloadUrl(uploaded.id),
        exportSha256,
        sourceModifiedTime: modifiedTime,
      };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // A format/tab error is deterministic — retrying other accounts won't help,
      // but access errors might, so keep trying and report the last message.
    }
  }

  return { ...base, status: "error", triedAccounts: tried, error: lastError };
}

/**
 * Export one or many Google Docs. Refs may be ids or urls, single or array,
 * freely mixed. Each is processed independently.
 *
 * @param accounts - accounts to try, in order (caller's intended account first).
 * @param tab - "all" (default), "first", or a tabId (Markdown-only for a single tab).
 */
export async function exportDocsToFiles(
  env: Env,
  accounts: ExportAccount[],
  input: string | string[],
  format: DocExportFormat = "pdf",
  tab: string = "all",
): Promise<DocExportResult[]> {
  const refs = parseDriveRefs(input);
  const results: DocExportResult[] = [];
  for (const { requested, id } of refs) {
    results.push(await exportOne(env, accounts, requested, id, format, tab));
  }
  return results;
}
