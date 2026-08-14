import { describe, it, expect, vi, beforeEach } from "vitest";

import { TOOLS, base64ToBytes } from "../tools";

// DriveService talks to Google via googleFetch → global fetch, with the access
// token minted by tokenProvider. Stub the token so no network/KV is touched.
vi.mock("../tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));

const tool = TOOLS.find((t) => t.name === "drive_upload_file")!;

let fetchSpy: any;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

describe("base64ToBytes", () => {
  it("decodes standard and url-safe base64", () => {
    expect(new TextDecoder().decode(base64ToBytes(btoa("hello")))).toBe("hello");
    // url-safe alphabet ( - _ ) must decode too
    const urlSafe = btoa("~~~?").replace(/\+/g, "-").replace(/\//g, "_");
    expect(base64ToBytes(urlSafe)).toEqual(base64ToBytes(btoa("~~~?")));
  });
});

describe("drive_upload_file tool", () => {
  it("is registered", () => {
    expect(tool).toBeTruthy();
  });

  it("uploads bytes straight into folderId and returns { id, name, url, folderId }", async () => {
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? new Response("", { status: 200 }) // media upload
        : new Response(JSON.stringify({ id: "file-1", name: "invoice.pdf", webViewLink: "https://drive/view/file-1" }), { status: 200 }),
    );

    const args = tool.inputSchema.parse({
      name: "invoice.pdf",
      mimeType: "application/pdf",
      contentBase64: btoa("PDFBYTES"),
      folderId: "folder-9",
    });
    const { result, asset } = await tool.run({ env: {} as any, sub: "s1" }, args);

    expect(result).toEqual({ id: "file-1", name: "invoice.pdf", url: "https://drive/view/file-1", folderId: "folder-9" });
    expect(asset).toMatchObject({ assetType: "drive", googleId: "file-1", url: "https://drive/view/file-1", action: "create" });

    // Metadata create must carry the target parent; media PATCH carries the bytes.
    const createCall = fetchSpy.mock.calls.find((c: any[]) => c[1]?.method === "POST");
    expect(JSON.parse(createCall[1].body as string).parents).toEqual(["folder-9"]);
    expect(fetchSpy.mock.calls.some((c: any[]) => c[1]?.method === "PATCH")).toBe(true);
  });

  it("resolves folderPath (creating folders) then uploads into the deepest folder", async () => {
    // Sequence per path segment: search (GET, empty) → createFolder (POST).
    // Then the upload: metadata create (POST) → media PATCH.
    let createdFolders = 0;
    const folderIds = ["id-A", "id-B"];
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response("", { status: 200 });
      if (init?.method === "POST") {
        const body = JSON.parse((init.body as string) ?? "{}");
        if (body.mimeType === "application/vnd.google-apps.folder") {
          return new Response(JSON.stringify({ id: folderIds[createdFolders++], name: "seg", mimeType: body.mimeType }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: "file-2", name: "notes.txt", webViewLink: "https://drive/view/file-2" }), { status: 200 });
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200 }); // search → empty
    });

    const args = tool.inputSchema.parse({
      name: "notes.txt",
      mimeType: "text/plain",
      contentBase64: btoa("hi"),
      folderPath: "A/B",
    });
    const { result } = await tool.run({ env: {} as any, sub: "s1" }, args);

    expect(result).toMatchObject({ id: "file-2", folderId: "id-B" });
    // The file's metadata create must be parented under the resolved deepest folder.
    const fileCreate = fetchSpy.mock.calls.find(
      (c: any[]) => c[1]?.method === "POST" && JSON.parse((c[1].body as string) ?? "{}").mimeType === "text/plain",
    );
    expect(JSON.parse(fileCreate[1].body as string).parents).toEqual(["id-B"]);
  });
});
