import { describe, it, expect } from "vitest";

import { markdownToGmailHtml, inlineGmailStyles, htmlToPlainText, composeBody } from "../compose";
import { buildRawMessage } from "../mime";
import { linksSectionText } from "../outgoing-attachments";

/** Decode a Gmail base64url `raw` back to the MIME string. */
function decodeRaw(raw: string): string {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

describe("markdownToGmailHtml", () => {
  it("renders markdown with inline styles (bold, heading, link)", () => {
    const html = markdownToGmailHtml("# Title\n\n**bold** and [link](https://a.b)");
    expect(html).toContain("<h1");
    expect(html).toMatch(/<h1[^>]*style="[^"]*font-weight:\s*700/);
    expect(html).toMatch(/<strong[^>]*style="[^"]*font-weight:\s*700/);
    expect(html).toMatch(/<a[^>]*href="https:\/\/a\.b"[^>]*style="[^"]*color:\s*#1a73e8/);
  });
});

describe("inlineGmailStyles", () => {
  it("inlines a <style> block's class rule and drops the <style> tag", () => {
    const out = inlineGmailStyles(`<style>.hi{color:red}</style><p class="hi">x</p>`);
    expect(out).not.toContain("<style");
    expect(out).toMatch(/<p[^>]*style="[^"]*color:\s*red/);
  });

  it("keeps the element's own inline style winning over defaults", () => {
    const out = inlineGmailStyles(`<a href="#" style="color:#000">x</a>`);
    expect(out).toMatch(/color:\s*#000/);
  });

  it("strips <script>, <link>, and other dangerous tags", () => {
    const out = inlineGmailStyles(
      `<p>hi</p><script>alert(1)</script><link rel="stylesheet" href="https://evil/x.css"><iframe src="https://evil"></iframe>`,
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<link/i);
    expect(out).not.toMatch(/<iframe/i);
    expect(out).toContain("hi");
  });

  it("strips on* event-handler attributes and javascript: URLs", () => {
    const out = inlineGmailStyles(`<a href="javascript:steal()" onclick="steal()" onmouseover="x()">click</a>`);
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toMatch(/onmouseover/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain("click");
  });
});

describe("composeBody sanitizes the html part", () => {
  it("removes a <script> block from html input end-to-end", () => {
    const r = composeBody({ html: "<p>safe</p><script>evil()</script>" });
    expect(r.html).toContain("safe");
    expect(r.html).not.toMatch(/<script|evil\(/i);
  });
});

describe("htmlToPlainText", () => {
  it("flattens to readable text with block breaks", () => {
    const t = htmlToPlainText("<h1>Hi</h1><p>line one</p><p>line two</p>");
    expect(t).toBe("Hi\nline one\nline two");
  });
});

describe("composeBody", () => {
  it("markdown wins and yields html + text", () => {
    const r = composeBody({ markdown: "**b**", html: "<i>ignored</i>", text: "ignored" });
    expect(r.html).toContain("<strong");
    expect(r.text).toBe("**b**");
  });
  it("plain text stays text-only (no html part)", () => {
    expect(composeBody({ text: "hello" })).toEqual({ text: "hello" });
  });
});

describe("buildRawMessage", () => {
  it("plain text → single text/plain part", () => {
    const mime = decodeRaw(buildRawMessage({ to: "a@b.com", subject: "Hi", text: "body" }));
    expect(mime).toContain("To: a@b.com");
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mime).toContain("body");
  });

  it("html → multipart/alternative with both parts", () => {
    const mime = decodeRaw(buildRawMessage({ to: "a@b.com", subject: "Hi", text: "plain", html: "<b>rich</b>" }));
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("text/plain");
    expect(mime).toContain("text/html");
    expect(mime).toContain("<b>rich</b>");
  });

  it("attachments → multipart/mixed with base64 part + disposition", () => {
    const mime = decodeRaw(
      buildRawMessage({
        to: "a@b.com",
        subject: "Hi",
        text: "see file",
        attachments: [{ filename: "x.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("hello") }],
      }),
    );
    expect(mime).toContain("multipart/mixed");
    expect(mime).toContain('Content-Disposition: attachment; filename="x.txt"');
    expect(mime).toContain(btoa("hello")); // aGVsbG8=
  });

  it("RFC2047-encodes a non-ASCII subject", () => {
    const mime = decodeRaw(buildRawMessage({ to: "a@b.com", subject: "café —", text: "x" }));
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/);
  });
});

describe("linksSectionText", () => {
  it("lists drive links as plain text", () => {
    expect(linksSectionText([{ name: "Doc", url: "https://d/1" }])).toContain("- Doc: https://d/1");
  });
});
