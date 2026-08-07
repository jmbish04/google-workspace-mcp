/**
 * @file drive/office-markdown.ts
 * @description Convert Office attachments (docx/xlsx/pptx) that have been
 * imported to Google-native files into Markdown, entirely over the Drive export
 * endpoint (no Node SDK, no external deps — runs in a V8 isolate):
 *
 *   - Google Docs      → native `text/markdown` export
 *   - Google Sheets    → `text/csv` export, converted to a Markdown pipe table
 *   - Google Slides    → `text/plain` export, top-level lines promoted to `##`
 *
 * The CSV→Markdown step is implemented inline (RFC-4180-ish parser) rather than
 * pulling `csv-to-markdown`, to keep the Worker bundle dependency-free.
 */
import type { DriveService } from "@/backend/mcp/services/drive";

/** The three convertible Office MIME types → the Google-native kind they import to. */
export const OFFICE_TO_GOOGLE: Record<string, { google: string; kind: "doc" | "sheet" | "slides" }> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    google: "application/vnd.google-apps.document",
    kind: "doc",
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    google: "application/vnd.google-apps.spreadsheet",
    kind: "sheet",
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    google: "application/vnd.google-apps.presentation",
    kind: "slides",
  },
};

/** Whether a MIME type is a convertible Office document. */
export function isConvertibleOffice(mimeType: string): boolean {
  return mimeType in OFFICE_TO_GOOGLE;
}

/** Parse a CSV string into rows of fields (handles quotes, embedded commas/newlines). */
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      // Close the row on \n or \r\n; swallow the paired \n after \r.
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // Flush the trailing field/row when the file doesn't end in a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

/** Render CSV text as a GitHub-flavored Markdown pipe table (first row = header). */
export function csvToMarkdown(csv: string): string {
  const rows = parseCsv(csv);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => {
    const cells = [...r];
    while (cells.length < width) cells.push("");
    return cells.map((c) => c.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim());
  };
  const header = pad(rows[0]);
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(" | ")} |`);
  return lines.join("\n");
}

/** Promote non-indented lines of a Slides plain-text export to `##` headings. */
export function slidesTextToMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim().length > 0 && !line.startsWith(" ") ? `\n## ${line.trim()}\n` : line))
    .join("\n");
}

/**
 * Export a Google-native file (previously imported from Office) as Markdown.
 *
 * @param fileId - the Google-native file id (Doc/Sheet/Slides)
 * @param kind - which native kind it is (drives the export strategy)
 */
export async function exportGoogleAsMarkdown(
  drive: DriveService,
  fileId: string,
  kind: "doc" | "sheet" | "slides",
): Promise<string> {
  if (kind === "doc") {
    return (await drive.exportFile(fileId, "text/markdown")).content;
  }
  if (kind === "sheet") {
    // CSV export covers the first sheet; multi-tab workbooks lose other tabs.
    return csvToMarkdown((await drive.exportFile(fileId, "text/csv")).content);
  }
  return slidesTextToMarkdown((await drive.exportFile(fileId, "text/plain")).content);
}
