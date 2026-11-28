import { describe, it, expect } from "vitest";

import { extractDirectText, isDirectTextAttachment, MAX_DIRECT_TEXT_CHARS } from "../attachment-text";
import { parseEml } from "../eml-parse";

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => btoa(String.fromCharCode(...enc(s)));

describe("extractDirectText: csv/txt/json", () => {
  it("decodes csv as UTF-8, strips BOM, keeps unicode", () => {
    const bytes = enc("﻿name,qty\nCafé,3\n");
    expect(extractDirectText(bytes, "text/csv", "a.csv")).toBe("name,qty\nCafé,3\n");
  });
  it("trusts the extension when Gmail labels it octet-stream", () => {
    expect(isDirectTextAttachment("application/octet-stream", "data.json")).toBe(true);
    expect(isDirectTextAttachment("application/octet-stream", "photo.bin")).toBe(false);
  });
  it("returns null for types it does not own (pdf, images) so OCR runs", () => {
    expect(extractDirectText(enc("%PDF"), "application/pdf", "a.pdf")).toBeNull();
    expect(extractDirectText(enc("x"), "image/png", "a.png")).toBeNull();
  });
  it("truncates oversized text with a marker", () => {
    const out = extractDirectText(enc("a".repeat(MAX_DIRECT_TEXT_CHARS + 10)), "text/plain", "big.txt")!;
    expect(out).toContain("[truncated:");
    expect(out.length).toBeLessThan(MAX_DIRECT_TEXT_CHARS + 100);
  });
  it("handles an empty file", () => {
    expect(extractDirectText(enc(""), "text/csv", "e.csv")).toBe("");
  });
});

describe("extractDirectText: message/rfc822", () => {
  const simple = [
    "From: =?UTF-8?B?Sm9zw6k=?= <jose@example.com>",
    "To: a@example.com,",
    " b@example.com",
    "Date: Mon, 1 Jan 2026 10:00:00 +0000",
    "Subject: Fwd: Invoice",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please see the invoice.",
  ].join("\r\n");

  it("returns forwarded headers and body", () => {
    const out = extractDirectText(enc(simple), "message/rfc822", "fwd.eml")!;
    expect(out).toContain("From: José <jose@example.com>");
    expect(out).toContain("To: a@example.com, b@example.com");
    expect(out).toContain("Subject: Fwd: Invoice");
    expect(out).toContain("Please see the invoice.");
  });
  it("walks multipart, decodes base64 + QP, lists nested attachments, ignores them as body", () => {
    const eml = [
      "Subject: multi",
      'Content-Type: multipart/mixed; boundary="B1"',
      "",
      "--B1",
      'Content-Type: multipart/alternative; boundary="B2"',
      "",
      "--B2",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>html only</p>",
      "--B2",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64("héllo plain"),
      "--B2--",
      "--B1",
      'Content-Type: text/csv; name="inner.csv"',
      'Content-Disposition: attachment; filename="inner.csv"',
      "",
      "a,b",
      "--B1--",
      "",
    ].join("\r\n");
    const p = parseEml(enc(eml));
    expect(p.body).toBe("héllo plain");
    expect(p.attachmentNames).toEqual(["inner.csv"]);
    const qp = parseEml(enc("Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\ncaf=C3=A9 =\nbar"));
    expect(qp.body).toBe("café bar");
  });
  it("falls back to stripped html when there is no text part", () => {
    const p = parseEml(enc("Content-Type: text/html\n\n<div>Hi<br>there</div>"));
    expect(p.body).toBe("Hi\nthere");
  });
});
