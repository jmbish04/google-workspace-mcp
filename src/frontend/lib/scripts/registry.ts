/**
 * @file lib/scripts/registry.ts
 * @description The catalog of downloadable scripts. Add an entry here and it
 * appears on /docs/scripts and gets its own generated page — no other wiring.
 */
import type { ScriptSpec } from "./types";

export const SCRIPTS: ScriptSpec[] = [
  {
    slug: "drive-folder-report",
    title: "Drive Folder Report",
    summary:
      "Recursively list every file and folder under a Drive folder — name, hash, size, path, owners, permissions, download links.",
    tag: "Drive",
    emoji: "📁",
    tool: "drive_folder_tree",
    params: [
      {
        name: "folderId",
        label: "Folder ID or URL",
        required: true,
        placeholder: "1AbC… or https://drive.google.com/drive/folders/…",
        help: "The Drive folder to walk. A full folder URL works too.",
      },
      {
        name: "maxNodes",
        label: "Max nodes",
        type: "number",
        default: "2000",
        help: "Cap on files+folders visited (1–5000). result.truncated is true if hit.",
      },
      {
        name: "as_user",
        label: "Act as (email, optional)",
        placeholder: "you@yourdomain.com",
        help: "Run as a specific connected account. Omit to use the default account.",
      },
    ],
    resultNote: "Returns { rootId, count, files, folders, truncated, entries[] } — one entry per file/folder.",
  },
];

/** Look up a script by slug (for the dynamic page route). */
export function getScript(slug: string): ScriptSpec | undefined {
  return SCRIPTS.find((s) => s.slug === slug);
}
