import { describe, it, expect } from "vitest";

import {
  markdownToGmailHtml,
  inlineGmailStyles,
  htmlToPlainText,
  composeBody,
  GmailBodyError,
  GMAIL_BODY_STYLE,
} from "../compose";
import { buildRawMessage, formatAddress } from "../mime";
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
    expect(html).toMatch(/<a[^>]*href="https:\/\/a\.b"[^>]*style="[^"]*color:\s*#1155cc/);
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
  it("separates paragraphs with a blank line, list items with one", () => {
    // The text alternative must carry the same paragraph breaks as the HTML —
    // otherwise it reproduces exactly the run-together wall of text the HTML
    // part exists to fix.
    expect(htmlToPlainText("<h1>Hi</h1><p>line one</p><p>line two</p>")).toBe("Hi\n\nline one\n\nline two");
    expect(htmlToPlainText("<ul><li>a</li><li>b</li></ul>")).toBe("a\nb");
  });
});

describe("composeBody — HTML is the standard", () => {
  const UUID = "123e4567-e89b-42d3-a456-426614174000";

  it("gives a plain-text body a real HTML part in the house container", () => {
    // The whole point: a text-only body loses bullets, numbering, links, bold
    // and paragraph spacing. Every body now ships an HTML alternative.
    const r = composeBody({ text: "One.\n\nTwo." });
    expect(r.html.startsWith(`<div dir="ltr" style="${GMAIL_BODY_STYLE}">`)).toBe(true);
    expect(r.html).toMatch(/<p[^>]*>One\.<\/p>/);
    expect(r.html).toMatch(/<p[^>]*>Two\.<\/p>/);
    expect(r.text).toBe("One.\n\nTwo.");
  });

  it("uses the spec's container: 650px, full width, left, transparent", () => {
    // Explicitly not a centered boxed card on a grey field — this is personal
    // mail, and a line must not run the full width of a 32-inch monitor.
    const html = composeBody({ text: "hi" }).html;
    expect(html).toContain("max-width:650px");
    expect(html).toContain("width:100%");
    expect(html).toContain("text-align:left");
    expect(html).toContain("background-color:transparent");
    expect(html).not.toContain("#f4f4f4");
  });

  it("repeats the safe typography on the paragraph, not just the wrapper", () => {
    // Gmail drops the wrapper's font when the message is quoted in a reply.
    const html = composeBody({ text: "hi" }).html;
    expect(html).toMatch(/<p[^>]*style="[^"]*font-family:\s*Arial,\s*Helvetica,\s*sans-serif/);
    expect(html).toMatch(/<p[^>]*style="[^"]*font-size:\s*14px/);
    expect(html).toMatch(/<p[^>]*style="[^"]*line-height:\s*1\.5/);
    expect(html).toMatch(/<p[^>]*style="[^"]*color:\s*#222222/);
  });

  it("escapes plain text rather than letting it become markup", () => {
    expect(composeBody({ text: "a <b>x</b>" }).html).toContain("a &lt;b&gt;x&lt;/b&gt;");
  });

  it("spaces paragraphs with a 16px margin, never with empty blocks or <br>", () => {
    // Faked spacing is what AI-written bodies do, and it collapses differently
    // in every client.
    const r = composeBody({ markdown: "First.\n\nSecond.\n\nThird." });
    expect(r.html.match(/<p[^>]*>/g)).toHaveLength(3);
    expect(r.html).toMatch(/<p[^>]*style="[^"]*margin:\s*0 0 16px 0/);
    expect(r.html).not.toContain("<br>");
    expect(r.html).not.toMatch(/<p[^>]*><\/p>/);
  });

  it("drops the blank spacer divs in a body copied out of Gmail", () => {
    const r = composeBody({ html: "<div>One.</div><div><br></div><div>Two.</div>" });
    expect(r.html.match(/<p[^>]*>/g)).toHaveLength(2);
    expect(r.text).toBe("One.\n\nTwo.");
  });

  it("styles lists to spec: 24px indent, visible marker, 6px between items", () => {
    const ul = composeBody({ markdown: "- one\n- two" }).html;
    expect(ul).toMatch(/<ul[^>]*style="[^"]*list-style-type:\s*disc/);
    expect(ul).toMatch(/<ul[^>]*style="[^"]*padding-left:\s*24px/);
    expect(ul).toMatch(/<li[^>]*style="[^"]*margin-bottom:\s*6px/);
    const ol = composeBody({ markdown: "1. one\n2. two" }).html;
    expect(ol).toMatch(/<ol[^>]*style="[^"]*list-style-type:\s*decimal/);
  });

  it("styles bold, italics, links and quotes to spec, all inline", () => {
    const r = composeBody({
      markdown: "**bold** *soft* and [link](https://a.b)\n\n> quoted",
    });
    expect(r.html).toMatch(/<strong[^>]*style="[^"]*font-weight:\s*700/);
    expect(r.html).toMatch(/<strong[^>]*style="[^"]*color:\s*#222222/);
    expect(r.html).toMatch(/<em[^>]*style="[^"]*font-style:\s*italic/);
    expect(r.html).toMatch(/<a[^>]*href="https:\/\/a\.b"[^>]*style="[^"]*color:\s*#1155cc/);
    expect(r.html).toMatch(/<a[^>]*style="[^"]*text-decoration:\s*underline/);
    expect(r.html).toMatch(/<blockquote[^>]*style="[^"]*border-left:\s*2px solid #dadce0/);
    expect(r.html).not.toContain("<style");
  });

  it("inlines the named class hooks an author can use", () => {
    // A `<style>` rule would be dropped the first time the mail is quoted.
    const r = composeBody({ html: '<p><span class="highlight-red">overdue</span></p>' });
    expect(r.html).toMatch(/<span[^>]*style="[^"]*color:\s*#c5221f/);
    expect(r.html).toMatch(/<span[^>]*style="[^"]*font-weight:\s*600/);
  });

  it("markdown wins and the text alternative is the rendered text, not raw markdown", () => {
    const r = composeBody({ markdown: "**b**", html: "<i>ignored</i>", text: "ignored" });
    expect(r.html).toContain("<strong");
    expect(r.text).toBe("b");
    expect(r.report.source).toBe("markdown");
  });

  it("stamps exactly one hidden reference id, invisible in both parts", () => {
    const r = composeBody({ text: "hi" }, { uuid: UUID });
    expect(r.html.split("ref:").length - 1).toBe(1);
    expect(r.html).toMatch(/color:#ffffff[^"]*"[^>]*>ref:/);
    expect(r.text).not.toContain("ref:");
  });

  it("strips reference ids carried over from an earlier draft", () => {
    // Revision two of a draft arrives with revision one's id still in the body.
    const first = composeBody({ text: "v1" }, { uuid: "11111111-e89b-42d3-a456-426614174000" });
    const second = composeBody({ html: first.html }, { uuid: UUID });
    expect(second.html.split("ref:").length - 1).toBe(1);
    expect(second.html).toContain(`ref:${UUID}`);
    expect(second.report.removedRefs).toEqual(["11111111-e89b-42d3-a456-426614174000"]);
  });

  it("strips another message's authorship watermark tags", () => {
    const foreign =
      '<div>Hi<span data-plaintext="omit"> [authored v1 11111111-e89b-42d3-a456-426614174000 0 abcdef012345]</span></div>';
    const r = composeBody({ html: foreign }, { uuid: UUID });
    expect(r.html).not.toContain("authored v1");
    expect(r.report.removedAuthorTags).toBe(1);
  });

  it("does not nest one Gmail wrapper inside another when a body is re-composed", () => {
    const once = composeBody({ text: "hi" }).html;
    const twice = composeBody({ html: once }).html;
    expect(twice.split('dir="ltr"').length - 1).toBe(1);
  });

  it("leaves a prebuilt (already signed) body byte-identical", () => {
    const signed = '<div dir="ltr" style="x">signed bytes</div>';
    expect(composeBody({ html: signed }, { uuid: UUID, prebuilt: true }).html).toBe(signed);
  });

  it("rejects a body that sanitizes down to nothing", () => {
    expect(() => composeBody({ html: "<script>evil()</script>" })).toThrow(GmailBodyError);
  });

  it("reports what it removed so the sender can see it", () => {
    const r = composeBody({ html: "<p>hi</p><form><input></form>" });
    expect(r.report.removedUnsafe).toContain("form");
    expect(r.report.warnings.join(" ")).toMatch(/Gmail strips these/);
  });
});

describe("formatAddress", () => {
  it("puts the sender's name on the message so the inbox is not a bare address", () => {
    expect(formatAddress("justin@126colby.com", "Justin Bishop")).toBe('"Justin Bishop" <justin@126colby.com>');
  });
  it("falls back to the bare address when no name is known", () => {
    expect(formatAddress("a@b.com")).toBe("a@b.com");
    expect(formatAddress("a@b.com", "  ")).toBe("a@b.com");
  });
  it("RFC2047-encodes a non-ASCII name (encoded words are never quoted)", () => {
    const v = formatAddress("a@b.com", "José Álvarez");
    expect(v).toMatch(/^=\?UTF-8\?B\?[^ ]+\?= <a@b\.com>$/);
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
