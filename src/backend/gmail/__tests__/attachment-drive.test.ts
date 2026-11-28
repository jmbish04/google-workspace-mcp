import { describe, it, expect, vi } from "vitest";

vi.mock("@/backend/mcp/services/drive", () => ({
  DriveService: class {
    async uploadBinary(name: string) {
      return { id: `drv-${name}`, webViewLink: null };
    }
  },
}));
vi.mock("../ocr-service", () => ({ ocrAttachment: vi.fn(async () => "OCR-TEXT") }));

import { uploadMessageAttachments } from "../attachment-drive";

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const part = (id: string, filename: string, mimeType: string) => ({
  filename,
  mimeType,
  body: { attachmentId: id, size: 100 },
});
const DATA: Record<string, string> = {
  csv: "sku,qty\nA1,2\n",
  eml: "From: boss@example.com\nSubject: Fwd: PO\nContent-Type: text/plain\n\nApprove this.",
  pdf: "%PDF-1.4",
};

describe("uploadMessageAttachments doc_text routing", () => {
  it("decodes csv and forwarded eml directly; sends pdf to OCR", async () => {
    const gmail = { getAttachment: async (_m: string, id: string) => ({ data: b64url(DATA[id]) }) } as never;
    const payload = {
      parts: [part("csv", "q.csv", "text/csv"), part("eml", "fwd.eml", "message/rfc822"), part("pdf", "a.pdf", "application/pdf")],
    };
    const { attachments } = await uploadMessageAttachments({} as Env, "ref", "acct", {
      messageId: "m1",
      payload,
      subject: "s",
      folderId: "f1",
      gmail,
    });
    const by = Object.fromEntries(attachments.map((a) => [a.filename, a.doc_text]));
    expect(by["q.csv"]).toBe("sku,qty\nA1,2\n");
    expect(by["fwd.eml"]).toContain("From: boss@example.com");
    expect(by["fwd.eml"]).toContain("Approve this.");
    expect(by["a.pdf"]).toBe("OCR-TEXT");
  });
});
