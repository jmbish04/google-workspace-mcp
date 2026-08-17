import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { TOOLS } from "../tools";

// Stub the access token so no network/KV is touched; all Google calls go
// through the fetch spy below.
vi.mock("../tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));

const tool = TOOLS.find((t) => t.name === "docs_create")!;

let fetchSpy: any;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("docs_create folder placement", () => {
  it("creates in root then re-parents into folderId (Docs API can't set a parent)", async () => {
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://docs.googleapis.com")) {
        return new Response(JSON.stringify({ documentId: "doc-1", title: "x" }), { status: 200 });
      }
      // Drive: first the parents lookup (GET), then the re-parent PATCH.
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ id: "doc-1", name: "x", parents: ["folder-9"] }), { status: 200 });
      }
      return new Response(JSON.stringify({ parents: ["root"] }), { status: 200 });
    });

    const args = tool.inputSchema.parse({ title: "x", parentFolderId: "folder-9" });
    const { result } = await tool.run({ env: {} as any, sub: "s1" }, args);

    expect(result).toMatchObject({ documentId: "doc-1", folderId: "folder-9" });

    // The re-parent PATCH must add the target folder and drop the old root parent.
    const patch = fetchSpy.mock.calls.find((c: any[]) => c[1]?.method === "PATCH");
    expect(patch, "expected a Drive re-parent PATCH").toBeTruthy();
    expect(patch[0]).toContain("addParents=folder-9");
    expect(patch[0]).toContain("removeParents=root");
  });

  it("without a folder, leaves the doc in root (no Drive PATCH) and folderId is null", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ documentId: "doc-2", title: "y" }), { status: 200 }),
    );

    const args = tool.inputSchema.parse({ title: "y" });
    const { result } = await tool.run({ env: {} as any, sub: "s1" }, args);

    expect(result).toMatchObject({ documentId: "doc-2", folderId: null, folderMatches: null });
    expect(fetchSpy.mock.calls.some((c: any[]) => c[1]?.method === "PATCH")).toBe(false);
  });

  it("with folderKeyword (no id): creates in root, no move, returns folder-scoped matches", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("https://docs.googleapis.com")) {
        return new Response(JSON.stringify({ documentId: "doc-3", title: "z" }), { status: 200 });
      }
      // Drive files search (folder-scoped).
      return new Response(
        JSON.stringify({ files: [{ id: "fld-1", name: "IB Roofing Email drafts", mimeType: "application/vnd.google-apps.folder" }] }),
        { status: 200 },
      );
    });

    const args = tool.inputSchema.parse({ title: "z", folderKeyword: "IB Roofing Email drafts" });
    const { result } = await tool.run({ env: {} as any, sub: "s1" }, args);

    expect(result).toMatchObject({
      documentId: "doc-3",
      folderId: null,
      folderMatches: [{ id: "fld-1", name: "IB Roofing Email drafts" }],
    });
    // No re-parent move happened.
    expect(fetchSpy.mock.calls.some((c: any[]) => c[1]?.method === "PATCH")).toBe(false);
    // The search must be scoped to folders.
    const searchCall = fetchSpy.mock.calls.find((c: any[]) => String(c[0]).includes("q="));
    expect(decodeURIComponent(String(searchCall[0]))).toContain("mimeType='application/vnd.google-apps.folder'");
  });
});

describe("gmail_draft_doc", () => {
  const draftTool = TOOLS.find((t) => t.name === "gmail_draft_doc")!;

  it("is registered (code mode can discover it)", () => {
    expect(draftTool).toBeTruthy();
  });

  it("creates a doc, inserts body, and styles it Gmail-standard (Arial 11pt #222222)", async () => {
    let batchBody: any = null;
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith(":batchUpdate")) {
        batchBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ documentId: "doc-4" }), { status: 200 });
      }
      // documents.create
      return new Response(JSON.stringify({ documentId: "doc-4", title: "Subject" }), { status: 200 });
    });

    const args = draftTool.inputSchema.parse({ title: "Subject", body: "Hi there\n\nThanks" });
    const { result } = await draftTool.run({ env: {} as any, sub: "s1" }, args);

    expect(result).toMatchObject({
      documentId: "doc-4",
      url: "https://docs.google.com/document/d/doc-4/edit",
      folderId: null,
    });

    // One atomic batch: insertText then updateTextStyle over the inserted range.
    const [insert, style] = batchBody.requests;
    expect(insert.insertText).toMatchObject({ location: { index: 1 }, text: "Hi there\n\nThanks" });
    expect(style.updateTextStyle.range).toEqual({ startIndex: 1, endIndex: 1 + "Hi there\n\nThanks".length });
    expect(style.updateTextStyle.textStyle.weightedFontFamily).toEqual({ fontFamily: "Arial", weight: 400 });
    expect(style.updateTextStyle.textStyle.fontSize).toEqual({ magnitude: 11, unit: "PT" });
    expect(style.updateTextStyle.textStyle.foregroundColor.color.rgbColor.red).toBeCloseTo(0.13333334, 6);
  });

  it("with no body: creates the doc, no batchUpdate", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ documentId: "doc-5", title: "Empty" }), { status: 200 }),
    );

    const args = draftTool.inputSchema.parse({ title: "Empty" });
    const { result } = await draftTool.run({ env: {} as any, sub: "s1" }, args);

    expect(result).toMatchObject({ documentId: "doc-5", folderId: null });
    expect(fetchSpy.mock.calls.some((c: any[]) => String(c[0]).endsWith(":batchUpdate"))).toBe(false);
  });
});
