import { describe, it, expect } from "vitest";

import { buildRawMessage } from "../mime";

const decode = (raw: string) => decodeURIComponent(escape(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))));
const img = { filename: "logo.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]), contentId: "logo" };
const file = { filename: "doc.pdf", mimeType: "application/pdf", bytes: new Uint8Array([4, 5, 6]) };

describe("buildRawMessage", () => {
  it("embeds inline images as multipart/related with a Content-ID", () => {
    const m = decode(buildRawMessage({ to: "a@b.com", subject: "s", text: "hi", html: '<p><img src="cid:logo"></p>', attachments: [img] }));
    expect(m).toContain("multipart/related");
    expect(m).toContain("Content-ID: <logo>");
    expect(m).toContain("Content-Disposition: inline; filename=\"logo.png\"");
    expect(m).not.toContain("multipart/mixed"); // no regular attachments
  });

  it("nests related inside mixed when there are BOTH inline images and file attachments", () => {
    const m = decode(buildRawMessage({ to: "a@b.com", subject: "s", text: "hi", html: '<img src="cid:logo">', attachments: [img, file] }));
    expect(m).toContain("multipart/mixed");
    expect(m).toContain("multipart/related");
    expect(m).toContain("Content-ID: <logo>");
    expect(m).toContain('Content-Disposition: attachment; filename="doc.pdf"');
  });

  it("plain file attachment stays multipart/mixed (no related)", () => {
    const m = decode(buildRawMessage({ to: "a@b.com", subject: "s", text: "hi", html: "<p>hi</p>", attachments: [file] }));
    expect(m).toContain("multipart/mixed");
    expect(m).not.toContain("multipart/related");
  });

  it("no attachments → alternative/plain body directly", () => {
    const m = decode(buildRawMessage({ to: "a@b.com", subject: "s", text: "hi", html: "<p>hi</p>" }));
    expect(m).not.toContain("multipart/mixed");
    expect(m).not.toContain("multipart/related");
    expect(m).toContain("multipart/alternative");
  });
});
