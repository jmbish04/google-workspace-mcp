import { describe, it, expect, vi, beforeEach } from "vitest";

// DriveService → googleFetch → global fetch; token from tokenProvider. Stub the
// token and the account lookup so the routes need no network/DB.
vi.mock("@/backend/mcp/tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));

let accounts: { email: string; ref: string }[] = [];
vi.mock("@/backend/gmail/sync-service", () => ({ listCaptureAccounts: vi.fn(async () => accounts) }));

import { driveRouter } from "../drive";

const env: any = {};
let fetchSpy: any;

beforeEach(() => {
  accounts = [{ email: "a@x.com", ref: "sub-a" }];
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

describe("POST /api/drive/upload", () => {
  it("400s when no file part is present", async () => {
    const form = new FormData();
    form.set("folderPath", "A/B");
    const res = await driveRouter.request("/upload", { method: "POST", body: form }, env);
    expect(res.status).toBe(400);
  });

  it("uploads the file into a folderId and returns driveId + driveUrl", async () => {
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? new Response("", { status: 200 })
        : new Response(JSON.stringify({ id: "file-1", name: "report.pdf", webViewLink: "https://drive/view/file-1" }), { status: 200 }),
    );

    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "report.pdf", { type: "application/pdf" }));
    form.set("folderId", "folder-9");

    const res = await driveRouter.request("/upload", { method: "POST", body: form }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      driveId: "file-1",
      driveUrl: "https://drive/view/file-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      folderId: "folder-9",
    });
    const createCall = fetchSpy.mock.calls.find((c: any[]) => c[1]?.method === "POST");
    expect(JSON.parse(createCall[1].body as string).parents).toEqual(["folder-9"]);
  });

  it("resolves folderPath then uploads into the deepest folder", async () => {
    let folders = 0;
    const ids = ["id-A", "id-B"];
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response("", { status: 200 });
      if (init?.method === "POST") {
        const body = JSON.parse((init.body as string) ?? "{}");
        if (body.mimeType === "application/vnd.google-apps.folder") {
          return new Response(JSON.stringify({ id: ids[folders++], name: "seg", mimeType: body.mimeType }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: "file-2", name: "n.txt", webViewLink: "https://drive/view/file-2" }), { status: 200 });
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    });

    const form = new FormData();
    form.set("file", new File(["hi"], "n.txt", { type: "text/plain" }));
    form.set("folderPath", "A/B");

    const res = await driveRouter.request("/upload", { method: "POST", body: form }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ driveId: "file-2", folderId: "id-B" });
  });
});

describe("POST /api/drive/folders", () => {
  it("resolves a path and returns folderId + folderUrl", async () => {
    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ id: "id-X", name: "X", mimeType: "application/vnd.google-apps.folder" }), { status: 200 })
        : new Response(JSON.stringify({ files: [] }), { status: 200 }),
    );
    const res = await driveRouter.request(
      "/folders",
      { method: "POST", body: JSON.stringify({ folderPath: "X" }), headers: { "content-type": "application/json" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ folderId: "id-X", folderUrl: "https://drive.google.com/drive/folders/id-X" });
  });
});
