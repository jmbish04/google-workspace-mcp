import { describe, it, expect, vi, beforeEach } from "vitest";
import { DriveService } from "../drive";

let fetchSpy: any;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ files: [{ id: "f1", name: "Doc", mimeType: "application/vnd.google-apps.document" }] }), { status: 200 }),
  );
});
vi.mock("../../tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));

describe("DriveService.search", () => {
  it("calls Drive v3 files.list with q and fields", async () => {
    const svc = new DriveService({} as any, "s1");
    const out = await svc.search("name contains 'Doc'");
    expect(out.files[0].id).toBe("f1");
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("https://www.googleapis.com/drive/v3/files");
    expect(decodeURIComponent(url)).toContain("name contains 'Doc'");
  });
});

describe("DriveService.copy", () => {
  it("posts to files/{id}/copy with name and parents", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ id: "f2", name: "Doc copy", mimeType: "application/vnd.google-apps.document" }), { status: 200 }),
    );
    const svc = new DriveService({} as any, "s1");
    const out = await svc.copy("f1", "Doc copy", "parent1");
    expect(out.id).toBe("f2");
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
    const url = lastCall[0] as string;
    const init = lastCall[1] as RequestInit;
    expect(url).toContain("https://www.googleapis.com/drive/v3/files/f1/copy");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe("Doc copy");
    expect(body.parents).toEqual(["parent1"]);
  });
});

describe("DriveService.createFile", () => {
  it("posts a multipart/related upload with metadata + media parts", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ id: "f3", name: "notes.txt", mimeType: "text/plain" }), { status: 200 }),
    );
    const svc = new DriveService({} as any, "s1");
    const out = await svc.createFile("notes.txt", "text/plain", "hello world", "parent1");
    expect(out.id).toBe("f3");
    const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toContain("https://www.googleapis.com/upload/drive/v3/files");
    expect(url).toContain("uploadType=multipart");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toContain("multipart/related");
    const body = init.body as string;
    expect(body).toContain(`"name":"notes.txt"`);
    expect(body).toContain(`"parents":["parent1"]`);
    expect(body).toContain("hello world");
  });
});

describe("DriveService.readContent", () => {
  it("exports Google Docs to text/plain", async () => {
    fetchSpy.mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes("/export")) return new Response("exported text", { status: 200 });
      return new Response(JSON.stringify({ mimeType: "application/vnd.google-apps.document", name: "Doc" }), { status: 200 });
    });
    const svc = new DriveService({} as any, "s1");
    const out = await svc.readContent("f1");
    expect(out.exported).toBe(true);
    expect(out.mimeType).toBe("text/plain");
    expect(out.content).toBe("exported text");
    const exportCall = fetchSpy.mock.calls.find((c: any[]) => String(c[0]).includes("/export"))!;
    expect(decodeURIComponent(String(exportCall[0]))).toContain("mimeType=text/plain");
  });

  it("reads binary/plain files via alt=media", async () => {
    fetchSpy.mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes("alt=media")) return new Response("raw bytes", { status: 200 });
      return new Response(JSON.stringify({ mimeType: "text/plain", name: "file.txt" }), { status: 200 });
    });
    const svc = new DriveService({} as any, "s1");
    const out = await svc.readContent("f2");
    expect(out.exported).toBe(false);
    expect(out.mimeType).toBe("text/plain");
    expect(out.content).toBe("raw bytes");
  });
});

describe("DriveService.listRecent", () => {
  it("orders by modifiedTime desc", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ files: [{ id: "f1", name: "Doc", mimeType: "text/plain" }] }), { status: 200 }));
    const svc = new DriveService({} as any, "s1");
    const out = await svc.listRecent(5);
    expect(out.files[0].id).toBe("f1");
    const url = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][0] as string;
    expect(decodeURIComponent(url)).toContain("orderBy=modifiedTime desc");
    expect(url).toContain("pageSize=5");
  });
});

describe("DriveService.getPermissions", () => {
  it("gets permissions for a file", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ permissions: [{ id: "p1", type: "user", role: "writer", emailAddress: "a@b.com" }] }), { status: 200 }),
    );
    const svc = new DriveService({} as any, "s1");
    const out = await svc.getPermissions("f1");
    expect(out.permissions[0].id).toBe("p1");
    const url = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][0] as string;
    expect(url).toContain("/files/f1/permissions");
    expect(decodeURIComponent(url)).toContain("permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery)");
  });
});

describe("DriveService.share", () => {
  it("posts a permission to files/{id}/permissions", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ id: "p2", role: "writer", type: "user" }), { status: 200 }));
    const svc = new DriveService({} as any, "s1");
    const out = await svc.share("f1", "writer", "user", "a@b.com");
    expect(out.id).toBe("p2");
    const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toContain("/files/f1/permissions");
    expect(decodeURIComponent(url)).toContain("sendNotificationEmail=false");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ role: "writer", type: "user", emailAddress: "a@b.com" });
  });
});

describe("DriveService.deleteFile", () => {
  it("issues DELETE with supportsAllDrives", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    const svc = new DriveService({} as any, "s1");
    await svc.deleteFile("f1");
    const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toContain("/files/f1?");
    expect(url).toContain("supportsAllDrives=true");
    expect(init.method).toBe("DELETE");
  });
});

describe("DriveService.updateFile", () => {
  it("patches name and addParents/removeParents", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ id: "f1", name: "Renamed" }), { status: 200 }));
    const svc = new DriveService({} as any, "s1");
    const out = await svc.updateFile("f1", { name: "Renamed", addParents: "p2", removeParents: "p1" });
    expect(out.name).toBe("Renamed");
    const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toContain("/files/f1?");
    expect(url).toContain("addParents=p2");
    expect(url).toContain("removeParents=p1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Renamed" });
  });
});

describe("DriveService.exportFile", () => {
  it("exports a file to the requested mimeType", async () => {
    fetchSpy.mockResolvedValue(new Response("exported content", { status: 200 }));
    const svc = new DriveService({} as any, "s1");
    const out = await svc.exportFile("f1", "application/pdf");
    expect(out.content).toBe("exported content");
    expect(out.mimeType).toBe("application/pdf");
    const url = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][0] as string;
    expect(decodeURIComponent(url)).toContain("/files/f1/export?mimeType=application/pdf");
  });
});

describe("DriveService.resolveFolderPath", () => {
  it("find-or-creates each path segment and returns the deepest folder id", async () => {
    // Each segment: search returns no match → createFolder returns a new id.
    let created = 0;
    const ids = ["id-A", "id-B", "id-C"];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ id: ids[created++], name: "seg", mimeType: "application/vnd.google-apps.folder" }), { status: 200 })
        : new Response(JSON.stringify({ files: [] }), { status: 200 }),
    );
    fetchSpy.mockClear(); // scope call assertions to this test (calls accumulate across the file)
    const svc = new DriveService({} as any, "s1");
    const id = await svc.resolveFolderPath("A/B/C");
    expect(id).toBe("id-C");
    // One create per segment; the third is parented under the second folder.
    const posts = fetchSpy.mock.calls.filter((c: any[]) => c[1]?.method === "POST");
    expect(posts).toHaveLength(3);
    expect(JSON.parse(posts[2][1].body as string).parents).toEqual(["id-B"]);
  });

  it("escapes backslash and quote in a segment name so the Drive q can't be broken", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ files: [{ id: "x", name: "n", mimeType: "application/vnd.google-apps.folder" }] }), { status: 200 }),
    );
    fetchSpy.mockClear();
    const svc = new DriveService({} as any, "s1");
    await svc.resolveFolderPath("a\\' and '1'='1");
    const searchUrl = decodeURIComponent(fetchSpy.mock.calls[0][0] as string);
    // backslash escaped to \\, quote escaped to \' — the injected `and '1'='1`
    // stays inside the quoted literal.
    expect(searchUrl).toContain("name='a\\\\\\' and \\'1\\'=\\'1'");
  });

  it("reuses an existing folder when search finds one — no create", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ files: [{ id: "existing", name: "X", mimeType: "application/vnd.google-apps.folder" }] }), { status: 200 }),
    );
    fetchSpy.mockClear();
    const svc = new DriveService({} as any, "s1");
    const id = await svc.resolveFolderPath("X");
    expect(id).toBe("existing");
    expect(fetchSpy.mock.calls.some((c: any[]) => c[1]?.method === "POST")).toBe(false);
  });
});
