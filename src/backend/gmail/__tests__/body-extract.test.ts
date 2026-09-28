import { describe, it, expect } from "vitest";

import { extractBody, extractUrls } from "../body-extract";

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const payload = {
  mimeType: "multipart/alternative",
  parts: [
    { mimeType: "text/plain", body: { data: b64url("Hello world\nSee https://plain.example.com/x.") } },
    { mimeType: "text/html", body: { data: b64url('<p>Hi &amp; <a href="https://ex.com/a">Docs</a></p>') } },
  ],
};

describe("extractBody", () => {
  it("defaults to decoded plain text", () => {
    const r = extractBody(payload);
    expect(r.bodyFormat).toBe("text");
    expect(r.body).toContain("Hello world");
  });

  it("returns raw html when asked", () => {
    const r = extractBody(payload, "html");
    expect(r.bodyFormat).toBe("html");
    expect(r.body).toContain("<a href=");
  });

  it("returns raw rfc when raw supplied", () => {
    const r = extractBody(payload, "rfc", b64url("From: a@b.com\r\n\r\nRaw body"));
    expect(r.bodyFormat).toBe("rfc");
    expect(r.body).toContain("Raw body");
  });

  it("falls back to text when html requested but absent", () => {
    const plainOnly = { mimeType: "text/plain", body: { data: b64url("just text") } };
    expect(extractBody(plainOnly, "html").bodyFormat).toBe("text");
  });

  it("always extracts urls (anchor label + bare link), deduped", () => {
    const { urls } = extractBody(payload);
    expect(urls).toContainEqual({ label: "Docs", href: "https://ex.com/a" });
    expect(urls).toContainEqual({ label: "https://plain.example.com/x", href: "https://plain.example.com/x" });
  });
});

describe("extractUrls", () => {
  it("skips mailto/# and trims trailing punctuation on bare urls", () => {
    const urls = extractUrls('<a href="#">x</a><a href="mailto:a@b.com">m</a>', "go to https://y.com), done");
    expect(urls).toEqual([{ label: "https://y.com", href: "https://y.com" }]);
  });
});
