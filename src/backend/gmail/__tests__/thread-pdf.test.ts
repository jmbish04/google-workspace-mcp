import { describe, it, expect } from "vitest";

import { applyHighlights, buildThreadHtml, toRenderMessage } from "../thread-pdf";

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("applyHighlights", () => {
  it("wraps matched terms in a colored mark (case-insensitive)", () => {
    const out = applyHighlights("<p>Please send the Invoice for the invoice.</p>", [{ term: "invoice", color: "#ffe600" }]);
    expect(out).toContain('<mark style="background-color:#ffe600;padding:0 1px">Invoice</mark>');
    expect(out).toContain('<mark style="background-color:#ffe600;padding:0 1px">invoice</mark>');
  });

  it("never highlights inside tags/attributes (only text)", () => {
    const out = applyHighlights('<a href="https://x.com/invoice">click</a>', [{ term: "invoice", color: "#ff0" }]);
    expect(out).toBe('<a href="https://x.com/invoice">click</a>'); // href untouched, no text match
  });

  it("uses per-term colors and normalizes bare hex", () => {
    const out = applyHighlights("refund and invoice", [
      { term: "refund", color: "d8b4ff" },
      { term: "invoice", color: "#ffe600" },
    ]);
    expect(out).toContain('background-color:#d8b4ff');
    expect(out).toContain('background-color:#ffe600');
  });

  it("ignores invalid colors and returns input when nothing valid", () => {
    expect(applyHighlights("hello", [{ term: "hello", color: "notacolor" }])).toBe("hello");
  });
});

describe("toRenderMessage", () => {
  it("pulls headers + html body from a raw payload", () => {
    const raw = {
      payload: {
        headers: [
          { name: "From", value: "Alice <a@x.com>" },
          { name: "To", value: "b@y.com" },
          { name: "Date", value: "Mon, 1 Jan 2026 10:00:00 -0800" },
          { name: "Subject", value: "Hello" },
        ],
        mimeType: "text/html",
        body: { data: b64url("<p>Hi <b>there</b></p>") },
      },
    };
    const m = toRenderMessage(raw);
    expect(m.from).toBe("Alice <a@x.com>");
    expect(m.subject).toBe("Hello");
    expect(m.bodyHtml).toContain("<b>there</b>");
  });

  it("wraps plain-text bodies to preserve line breaks", () => {
    const raw = { payload: { headers: [], mimeType: "text/plain", body: { data: b64url("line1\nline2") } } };
    expect(toRenderMessage(raw).bodyHtml).toContain("white-space:pre-wrap");
  });
});

describe("buildThreadHtml", () => {
  it("renders subject + each message and applies highlights to bodies", () => {
    const html = buildThreadHtml(
      "Q4 Invoices",
      [{ from: "A", to: "B", date: "d", subject: "s", bodyHtml: "<p>invoice attached</p>" }],
      [{ term: "invoice", color: "#ffe600" }],
    );
    expect(html).toContain("Q4 Invoices");
    expect(html).toContain('<mark style="background-color:#ffe600');
  });
});
