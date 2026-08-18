import { describe, it, expect } from "vitest";

import { buildFolderTree } from "../folder-tree";
import { FOLDER_MIME, type DriveNode } from "@/backend/mcp/services/drive";

const ROOT = "root0";

function folder(id: string, name: string, parent: string): DriveNode {
  return { id, name, mimeType: FOLDER_MIME, parents: [parent], webViewLink: `https://drive.google.com/drive/folders/${id}` };
}

describe("buildFolderTree", () => {
  it("builds full relative paths through nested folders", () => {
    const nodes: DriveNode[] = [
      folder("sub", "Sub", ROOT),
      folder("deep", "Deep", "sub"),
      {
        id: "f1",
        name: "report.pdf",
        mimeType: "application/pdf",
        parents: ["deep"],
        md5Checksum: "abc",
        size: "1024",
        quotaBytesUsed: "1024",
        webContentLink: "https://dl/report",
        modifiedTime: "2026-01-02T03:04:05Z",
        owners: [{ displayName: "Jo", emailAddress: "jo@x.com" }],
        starred: true,
        permissions: [{ id: "p1", type: "user", role: "owner" }],
      },
    ];
    const out = buildFolderTree(ROOT, nodes, false);
    const file = out.entries.find((e) => e.id === "f1")!;
    expect(file.path).toBe("Sub/Deep/report.pdf");
    expect(file.hash).toBe("abc");
    expect(file.size).toBe(1024);
    expect(file.quotaBytesUsed).toBe(1024);
    expect(file.downloadUrl).toBe("https://dl/report");
    expect(file.parentId).toBe("deep");
    expect(file.parents).toEqual(["deep"]);
    expect(file.modifiedTime).toBe("2026-01-02T03:04:05Z");
    expect(file.owners[0].emailAddress).toBe("jo@x.com");
    expect(file.starred).toBe(true);
    expect(file.permissions).toHaveLength(1);
    expect(file.isFolder).toBe(false);
  });

  it("defaults array/flag fields when Drive omits them", () => {
    const out = buildFolderTree(ROOT, [folder("sub", "Sub", ROOT)], false);
    const dir = out.entries[0];
    expect(dir.owners).toEqual([]);
    expect(dir.permissions).toEqual([]);
    expect(dir.trashed).toBe(false);
    expect(dir.starred).toBe(false);
    expect(dir.explicitlyTrashed).toBe(false);
  });

  it("counts files vs folders and reports truncation", () => {
    const out = buildFolderTree(ROOT, [folder("sub", "Sub", ROOT)], true);
    expect(out.folders).toBe(1);
    expect(out.files).toBe(0);
    expect(out.truncated).toBe(true);
  });

  it("gives Google-native docs an export downloadUrl, folders none, and null hash", () => {
    const nodes: DriveNode[] = [
      folder("sub", "Sub", ROOT),
      { id: "doc", name: "Spec", mimeType: "application/vnd.google-apps.document", parents: [ROOT] },
    ];
    const out = buildFolderTree(ROOT, nodes, false);
    const doc = out.entries.find((e) => e.id === "doc")!;
    const dir = out.entries.find((e) => e.id === "sub")!;
    expect(doc.downloadUrl).toContain("/export?mimeType=");
    expect(doc.hash).toBeNull();
    expect(dir.downloadUrl).toBeNull();
    expect(doc.path).toBe("Spec");
  });

  it("stops path building when a parent isn't in the walked set (truncated walk)", () => {
    const nodes: DriveNode[] = [
      { id: "f1", name: "orphan.txt", mimeType: "text/plain", parents: ["missing"] },
    ];
    const out = buildFolderTree(ROOT, nodes, true);
    expect(out.entries[0].path).toBe("orphan.txt");
  });
});
