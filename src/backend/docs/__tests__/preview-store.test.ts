import { describe, it, expect, vi } from "vitest";

import { purgeExpiredPreviews, previewContentType, PREVIEW_TTL_MS } from "../preview-store";

describe("previewContentType", () => {
  it("infers type from extension", () => {
    expect(previewContentType("abc-p1.png")).toBe("image/png");
    expect(previewContentType("abc.pdf")).toBe("application/pdf");
    expect(previewContentType("abc.bin")).toBe("application/octet-stream");
  });
});

describe("purgeExpiredPreviews", () => {
  it("deletes only objects older than the 48h TTL, across pages", async () => {
    const now = Date.now();
    const old1 = { key: "a.png", uploaded: new Date(now - PREVIEW_TTL_MS - 1000) };
    const fresh = { key: "b.png", uploaded: new Date(now - 1000) };
    const old2 = { key: "c.pdf", uploaded: new Date(now - PREVIEW_TTL_MS - 5000) };
    const deleted: string[] = [];
    const env = {
      R2_PREVIEWS_BUCKET: {
        list: vi
          .fn()
          .mockResolvedValueOnce({ objects: [old1, fresh], truncated: true, cursor: "c1" })
          .mockResolvedValueOnce({ objects: [old2], truncated: false }),
        delete: vi.fn(async (k: string) => { deleted.push(k); }),
      },
    } as any;

    const removed = await purgeExpiredPreviews(env);
    expect(removed).toBe(2);
    expect(deleted).toEqual(["a.png", "c.pdf"]);
    expect(deleted).not.toContain("b.png");
  });
});
