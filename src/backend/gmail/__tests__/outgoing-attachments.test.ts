import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DriveService so resolveAttachments runs without network. `getContentMeta`
// reports a controllable size; `downloadBytes` returns a tiny stub (size drives
// the attach-vs-link decision, not the stub length).
const META: Record<string, { id: string; name: string; mimeType: string; size: number; webViewLink: string }> = {
  small: { id: "small", name: "small.pdf", mimeType: "application/pdf", size: 1000, webViewLink: "https://drive/small" },
  doc: { id: "doc", name: "Doc.pdf", mimeType: "application/pdf", size: 2000, webViewLink: "https://drive/doc" },
  big1: { id: "big1", name: "big1.bin", mimeType: "application/octet-stream", size: 10 * 1024 * 1024, webViewLink: "https://drive/big1" },
  big2: { id: "big2", name: "big2.bin", mimeType: "application/octet-stream", size: 10 * 1024 * 1024, webViewLink: "https://drive/big2" },
};
const shareCalls: { id: string; role: string; type: string }[] = [];
const uploadCalls: string[] = [];

vi.mock("@/backend/mcp/services/drive", () => ({
  DriveService: class {
    async getContentMeta(id: string) {
      return META[id];
    }
    async downloadBytes(_id: string) {
      return new Uint8Array([1, 2, 3]);
    }
    async uploadBinary(name: string) {
      uploadCalls.push(name);
      return { id: `up_${name}`, name, webViewLink: `https://drive/up_${name}` };
    }
    async share(id: string, role: string, type: string) {
      shareCalls.push({ id, role, type });
      return {};
    }
  },
}));

const { resolveAttachments } = await import("../outgoing-attachments");
const env = {} as unknown as Env;

beforeEach(() => {
  shareCalls.length = 0;
  uploadCalls.length = 0;
});

describe("resolveAttachments", () => {
  it("attaches a small blob as a real MIME part", async () => {
    const r = await resolveAttachments(env, "ref", [{ blob: btoa("hello"), filename: "note.txt", mimeType: "text/plain" }]);
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].filename).toBe("note.txt");
    expect(r.links).toHaveLength(0);
    expect(r.report[0]).toMatchObject({ filename: "note.txt", disposition: "attached", source: "blob" });
  });

  it("as:'link' shares anyone-with-link and inserts a URL instead of attaching", async () => {
    const r = await resolveAttachments(env, "ref", [{ driveFileId: "doc", as: "link" }]);
    expect(r.attachments).toHaveLength(0);
    expect(r.links).toEqual([{ name: "Doc.pdf", url: "https://drive/doc" }]);
    expect(r.report[0]).toMatchObject({ disposition: "linked-by-request", url: "https://drive/doc" });
    expect(shareCalls).toContainEqual({ id: "doc", role: "reader", type: "anyone" });
  });

  it("pushes the over-budget overflow to links, keeping earlier files attached", async () => {
    // big1 (10 MiB) fits (~13.3 MiB encoded); big1+big2 (~26.6 MiB) exceeds the 25 MiB cap.
    const r = await resolveAttachments(env, "ref", [{ driveFileId: "big1" }, { driveFileId: "big2" }]);
    expect(r.attachments.map((a) => a.filename)).toEqual(["big1.bin"]);
    expect(r.report.find((x) => x.filename === "big1.bin")!.disposition).toBe("attached");
    expect(r.report.find((x) => x.filename === "big2.bin")!.disposition).toBe("linked-over-limit");
    expect(shareCalls).toContainEqual({ id: "big2", role: "reader", type: "anyone" });
  });

  it("uploads + links an over-budget blob (blobs aren't in Drive to link directly)", async () => {
    // First a big drive file fills the budget, then a blob overflows → uploaded + linked.
    const r = await resolveAttachments(env, "ref", [
      { driveFileId: "big1" },
      { blob: btoa("x".repeat(1000)), filename: "overflow.txt" },
    ]);
    // big1 attached; blob can't fit → uploaded then linked.
    expect(r.report.find((x) => x.filename === "big1.bin")!.disposition).toBe("attached");
    // With big1 (~13.3 MiB) used, a 1 KB blob still fits — force the overflow path via as:'link' instead:
    const r2 = await resolveAttachments(env, "ref", [{ blob: btoa("y"), filename: "forced.txt", as: "link" }]);
    expect(uploadCalls).toContain("forced.txt");
    expect(r2.report[0]).toMatchObject({ disposition: "linked-by-request", source: "blob" });
    expect(r.attachments.length).toBeGreaterThan(0);
  });
});
