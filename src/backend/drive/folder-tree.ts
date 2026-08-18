/**
 * @file drive/folder-tree.ts
 * @description Flat recursive listing of a Drive folder — the standard "print
 * this folder / report these search results" shape. Built on the same capped
 * BFS as the sharing audit (`walkFolder` → `DriveService.listChildren`, which
 * already requests permissions/parents/hash/size inline), so it costs one list
 * call per folder and no per-file fetches.
 *
 * `buildFolderTree` is pure: it turns walked nodes into report entries and
 * reconstructs each node's path relative to the root by walking `parents` up
 * through the walked set (no extra API calls).
 */
import { FOLDER_MIME, type DriveNode, type DrivePermission, type DriveUser } from "@/backend/mcp/services/drive";

/** Export format per Google-native mimeType, for a download link when there's no binary. */
const NATIVE_EXPORT: Record<string, string> = {
  "application/vnd.google-apps.document": "application/pdf",
  "application/vnd.google-apps.spreadsheet": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.google-apps.presentation": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.google-apps.drawing": "image/png",
};

/** Best-effort download link: webContentLink (binary) → export URL (native docs) → null (folders). */
function downloadLink(node: DriveNode): string | null {
  if (node.webContentLink) return node.webContentLink;
  const exportMime = NATIVE_EXPORT[node.mimeType];
  if (exportMime) {
    return `https://www.googleapis.com/drive/v3/files/${node.id}/export?mimeType=${encodeURIComponent(exportMime)}`;
  }
  return null;
}

/** One file/folder in a recursive folder report. */
export interface DriveTreeEntry {
  id: string;
  name: string;
  mimeType: string;
  /** Path relative to (and excluding) the root folder, e.g. "Sub/Deep/report.pdf". */
  path: string;
  /** md5Checksum, or null for folders / Google-native docs (which have no hash). */
  hash: string | null;
  /** Byte size (0 for folders / Google-native docs). */
  size: number;
  /** Storage quota consumed, in bytes (0 when Drive reports none). */
  quotaBytesUsed: number;
  createdTime?: string;
  modifiedTime?: string;
  viewedByMeTime?: string;
  sharedWithMeTime?: string;
  owners: DriveUser[];
  /** The user who explicitly shared the file, if any. */
  sharingUser?: DriveUser;
  /** Full access-control list (the file's permissions) as JSON. */
  permissions: DrivePermission[];
  trashed: boolean;
  starred: boolean;
  explicitlyTrashed: boolean;
  /** All parent folder ids. */
  parents: string[];
  /** Immediate parent folder id (first of `parents`). */
  parentId?: string;
  /** Open-in-browser link. */
  webViewLink?: string;
  /** Direct-download link for binary contents (absent for folders / native docs). */
  webContentLink?: string;
  /**
   * Best download link: `webContentLink` for binary files, an export URL for
   * Google-native Docs/Sheets/Slides, null for folders.
   */
  downloadUrl: string | null;
  isFolder: boolean;
}

export interface FolderTreeResult {
  rootId: string;
  count: number;
  files: number;
  folders: number;
  /** True when the underlying walk hit its node cap before finishing. */
  truncated: boolean;
  entries: DriveTreeEntry[];
}

/**
 * Turn walked descendant nodes into a flat report with full relative paths.
 * Pure — no I/O. Paths are reconstructed from each node's `parents` chain up to
 * `rootId`; a node whose parent isn't in the walked set (e.g. the walk was
 * truncated) just gets a shorter path from where the chain breaks.
 */
export function buildFolderTree(rootId: string, nodes: DriveNode[], truncated: boolean): FolderTreeResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const pathOf = (node: DriveNode): string => {
    const segments = [node.name];
    const seen = new Set<string>([node.id]); // guard against cyclic parents
    let parentId = node.parents?.[0];
    while (parentId && parentId !== rootId && !seen.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent) break;
      seen.add(parentId);
      segments.unshift(parent.name);
      parentId = parent.parents?.[0];
    }
    return segments.join("/");
  };

  let files = 0;
  let folders = 0;
  const entries = nodes.map((n): DriveTreeEntry => {
    const isFolder = n.mimeType === FOLDER_MIME;
    if (isFolder) folders++;
    else files++;
    return {
      id: n.id,
      name: n.name,
      mimeType: n.mimeType,
      path: pathOf(n),
      hash: n.md5Checksum ?? null,
      size: Number(n.size ?? 0),
      quotaBytesUsed: Number(n.quotaBytesUsed ?? 0),
      createdTime: n.createdTime,
      modifiedTime: n.modifiedTime,
      viewedByMeTime: n.viewedByMeTime,
      sharedWithMeTime: n.sharedWithMeTime,
      owners: n.owners ?? [],
      sharingUser: n.sharingUser,
      permissions: n.permissions ?? [],
      trashed: n.trashed ?? false,
      starred: n.starred ?? false,
      explicitlyTrashed: n.explicitlyTrashed ?? false,
      parents: n.parents ?? [],
      parentId: n.parents?.[0],
      webViewLink: n.webViewLink,
      webContentLink: n.webContentLink,
      downloadUrl: isFolder ? null : downloadLink(n),
      isFolder,
    };
  });

  return { rootId, count: entries.length, files, folders, truncated, entries };
}
