/**
 * @file appscript/merge-files.ts
 * @description Pure file-merge for the Apps Script deploy pipeline.
 *
 * Apps Script identifies a file by its `name` alone (a project can't hold two
 * files with the same name), and the manifest is the file named `appsscript`
 * (type JSON). The deploy pipeline does a read → merge → write so pushing a new
 * helper never drops existing files or the manifest: incoming files overlay
 * existing ones by name, everything else is preserved.
 */

export type AppsScriptFileType = "SERVER_JS" | "HTML" | "JSON";

export interface AppsScriptFile {
  name: string;
  type: AppsScriptFileType;
  source: string;
}

/**
 * Merge `incoming` files over `existing`, keyed by file name.
 *
 * - Existing files not named in `incoming` are preserved (including the
 *   `appsscript` manifest — unless the caller explicitly overrides it).
 * - Incoming files replace same-named existing files, or are appended.
 * - Order: existing files keep their position; brand-new files are appended.
 */
export function mergeAppsScriptFiles(existing: AppsScriptFile[], incoming: AppsScriptFile[]): AppsScriptFile[] {
  const byName = new Map<string, AppsScriptFile>();
  for (const f of existing) byName.set(f.name, f);

  const order: string[] = existing.map((f) => f.name);
  for (const f of incoming) {
    if (!byName.has(f.name)) order.push(f.name);
    byName.set(f.name, f);
  }
  return order.map((name) => byName.get(name) as AppsScriptFile);
}

/** Whether the merged file set still contains the manifest (`appsscript` JSON). */
export function hasManifest(files: AppsScriptFile[]): boolean {
  return files.some((f) => f.name === "appsscript");
}
