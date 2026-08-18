import { describe, it, expect } from "vitest";

import { extractAttachmentParts, isJunkAttachment, keepableAttachments, attachmentManifest } from "../attachments";

const att = (over: Partial<ReturnType<typeof extractAttachmentParts>[number]>) => ({
  attachmentId: "a",
  filename: "",
  mimeType: "application/octet-stream",
  size: 0,
  inline: false,
  contentId: null,
  ...over,
});

describe("isJunkAttachment", () => {
  it("keeps non-image attachments (pdf, docx)", () => {
    expect(isJunkAttachment(att({ mimeType: "application/pdf", filename: "report.pdf", size: 50000 }))).toBe(false);
  });
  it("drops inline / content-id images (signatures)", () => {
    expect(isJunkAttachment(att({ mimeType: "image/png", inline: true, filename: "x.png", size: 5000 }))).toBe(true);
    expect(isJunkAttachment(att({ mimeType: "image/png", contentId: "logo1", filename: "x.png", size: 90000 }))).toBe(true);
  });
  it("drops logo/social/tiny images by name or size", () => {
    expect(isJunkAttachment(att({ mimeType: "image/png", filename: "image001.png", size: 3000 }))).toBe(true);
    expect(isJunkAttachment(att({ mimeType: "image/png", filename: "instagram.png", size: 90000 }))).toBe(true);
    expect(isJunkAttachment(att({ mimeType: "image/jpeg", filename: "x.jpg", size: 1000 }))).toBe(true);
  });
  it("keeps a real standalone photo", () => {
    expect(isJunkAttachment(att({ mimeType: "image/jpeg", filename: "vacation.jpg", size: 800000 }))).toBe(false);
  });
});

describe("extractAttachmentParts + keepableAttachments", () => {
  const payload = {
    parts: [
      { mimeType: "text/plain", body: { data: "x" } },
      { mimeType: "image/png", filename: "sig.png", body: { attachmentId: "att1", size: 4000 }, headers: [{ name: "Content-ID", value: "<sig>" }] },
      { mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "att2", size: 120000 }, headers: [{ name: "Content-Disposition", value: "attachment" }] },
    ],
  };
  it("finds attachment parts and filters junk", () => {
    expect(extractAttachmentParts(payload)).toHaveLength(2);
    const kept = keepableAttachments(payload);
    expect(kept.map((k) => k.filename)).toEqual(["invoice.pdf"]);
  });

  it("builds a metadata-only manifest (count + real attachments)", () => {
    const m = attachmentManifest(payload);
    expect(m.count).toBe(1);
    expect(m.attachments).toEqual([
      { filename: "invoice.pdf", mimeType: "application/pdf", size: 120000, attachmentId: "att2" },
    ]);
  });

  it("returns an empty manifest for a message with no attachments", () => {
    expect(attachmentManifest({ parts: [{ mimeType: "text/plain", body: { data: "x" } }] })).toEqual({
      count: 0,
      attachments: [],
    });
  });
});
