/**
 * @file google/sheet-export.ts
 * @description Clean utility: export Google Spreadsheet(s) to a JSON file saved
 * beside the source sheet, returning the exported file's Drive id / view url /
 * download url. Operates ONLY on Drive ids or Drive/Sheets urls (single or an
 * array, freely mixed) — url elements are reduced to bare ids automatically.
 *
 * Hardened for batch + multi-account use:
 *  - Each ref is processed independently; one failure never aborts the rest.
 *  - The sheet may live in ANY registered account (jmbish04@ vs justin@ …). Each
 *    account is tried in turn until one can read the sheet; the winning account
 *    is reported. If none can, an error report item is returned for that ref.
 *
 * The JSON reflects every tab. Two shapes: `records` (each tab → array of objects
 * keyed by the header row) or `values` (each tab → raw 2-D string array).
 *
 * D1 job tracking lives in the caller (mcp tool) — this stays a pure export unit.
 */
import { parseDriveRefs } from "@/backend/google/core/ids";
import { SheetsService } from "@/backend/mcp/services/sheets";
import { DriveService } from "@/backend/mcp/services/drive";

/** A registered account: its email and the token ref to act as it. */
export interface ExportAccount {
  email: string;
  ref: string;
}

export type ExportShape = "records" | "values";

/** Per-ref outcome. `status: "error"` items carry `error` and the accounts tried. */
export interface SheetExportResult {
  /** The original string the caller passed (id or url). */
  requested: string;
  /** Bare spreadsheet id extracted from `requested` (empty if unparseable). */
  spreadsheetId: string;
  status: "done" | "error";
  /** Email of the account the sheet was read from (on success). */
  sourceAccount?: string;
  /** Emails tried, in order (up to and including the winner). */
  triedAccounts: string[];
  tabCount?: number;
  jsonDriveId?: string;
  jsonDriveUrl?: string;
  jsonDownloadUrl?: string;
  /** SHA-256 (hex) of the exported JSON bytes. */
  jsonSha256?: string;
  /** The source spreadsheet's Drive modifiedTime at export (which revision was live). */
  sourceModifiedTime?: string;
  error?: string;
}

/** Normalize a single ref or array of refs into `{ requested, id }` pairs. @deprecated use {@link parseDriveRefs} */
export const parseSheetRefs = parseDriveRefs;

/** Drive-safe file name. */
function safeName(s: string): string {
  return (s || "spreadsheet").replace(/[^\w.-]+/g, "_").slice(0, 120);
}

/** Direct download url for a Drive file id (getDownloadUrl form). */
function downloadUrl(fileId: string): string {
  return `https://drive.google.com/uc?id=${fileId}&export=download`;
}

/** Lowercase hex SHA-256 of bytes (WebCrypto — available in Workers). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build the export JSON for one spreadsheet from its tab values. */
export function buildSheetJson(
  spreadsheetId: string,
  title: string,
  tabs: { title: string; values: string[][] }[],
  shape: ExportShape,
  exportedAt: string,
): { json: Record<string, unknown>; tabCount: number } {
  const out: Record<string, unknown> = {};
  for (const tab of tabs) {
    if (shape === "values") {
      out[tab.title] = tab.values;
      continue;
    }
    // records: first row is the header; each later row becomes an object.
    const [headers = [], ...rows] = tab.values;
    const keys = headers.map((h, i) => (h && h.trim() ? h : `col${i + 1}`));
    out[tab.title] = rows.map((row) =>
      Object.fromEntries(keys.map((k, i) => [k, row[i] ?? ""])),
    );
  }
  return {
    json: { spreadsheetId, title, exportedAt, shape, tabs: out },
    tabCount: tabs.length,
  };
}

/** Read every tab's values for a spreadsheet (single batchGet call). */
async function readAllTabs(
  sheets: SheetsService,
  spreadsheetId: string,
): Promise<{ title: string; tabs: { title: string; values: string[][] }[] }> {
  const meta = await sheets.getMetadata(spreadsheetId);
  const titles = [...meta.sheets]
    .sort((a, b) => a.properties.index - b.properties.index)
    .map((s) => s.properties.title);
  if (titles.length === 0) return { title: meta.properties.title, tabs: [] };
  const { valueRanges } = await sheets.batchGetValues(spreadsheetId, titles);
  const tabs = titles.map((title, i) => ({ title, values: valueRanges[i]?.values ?? [] }));
  return { title: meta.properties.title, tabs };
}

/**
 * Export one spreadsheet, trying each account until one can read it. Uploads the
 * JSON beside the source sheet (same parent folder) in the winning account.
 */
async function exportOne(
  env: Env,
  accounts: ExportAccount[],
  requested: string,
  spreadsheetId: string,
  shape: ExportShape,
  exportedAt: string,
): Promise<SheetExportResult> {
  const tried: string[] = [];
  let lastError = "no registered account could access this spreadsheet";

  for (const account of accounts) {
    tried.push(account.email);
    try {
      const sheets = new SheetsService(env, account.ref);
      const { title, tabs } = await readAllTabs(sheets, spreadsheetId);

      const { json, tabCount } = buildSheetJson(spreadsheetId, title, tabs, shape, exportedAt);
      const bytes = new TextEncoder().encode(JSON.stringify(json, null, 2));
      const jsonSha256 = await sha256Hex(bytes);

      const drive = new DriveService(env, account.ref);
      // Parents (to save beside the source) + modifiedTime (which revision was live).
      const { parents, modifiedTime } = await drive.getLocationInfo(spreadsheetId);
      const uploaded = await drive.uploadBinary(
        `${safeName(title)}.export.json`,
        "application/json",
        bytes,
        parents[0],
      );

      return {
        requested,
        spreadsheetId,
        status: "done",
        sourceAccount: account.email,
        triedAccounts: tried,
        tabCount,
        jsonDriveId: uploaded.id,
        jsonDriveUrl: uploaded.webViewLink ?? `https://drive.google.com/file/d/${uploaded.id}/view`,
        jsonDownloadUrl: downloadUrl(uploaded.id),
        jsonSha256,
        sourceModifiedTime: modifiedTime,
      };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // Try the next account — the sheet may belong to a different one.
    }
  }

  return { requested, spreadsheetId, status: "error", triedAccounts: tried, error: lastError };
}

/**
 * Export one or many spreadsheets to JSON. Refs may be Drive ids or urls, single
 * or an array, freely mixed. Each is processed independently.
 *
 * @param accounts - registered accounts to try, in order (put the caller's
 *   intended account first; the rest act as automatic cross-account fallback).
 */
export async function exportSheetsToJson(
  env: Env,
  accounts: ExportAccount[],
  input: string | string[],
  shape: ExportShape = "records",
): Promise<SheetExportResult[]> {
  const refs = parseSheetRefs(input);
  const exportedAt = new Date().toISOString();
  const results: SheetExportResult[] = [];
  // Sequential: bounds Workers subrequests when a large array is passed.
  for (const { requested, id } of refs) {
    results.push(await exportOne(env, accounts, requested, id, shape, exportedAt));
  }
  return results;
}
