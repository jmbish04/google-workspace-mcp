/**
 * @fileoverview Pure merge logic behind `gmail_update_draft` — body modes
 * (replace / append / prepend), wrapper unwrapping, and case-insensitive Cc/Bcc
 * de-duplication. No network: these functions decide WHAT body and WHICH
 * recipients the rebuild gets, before `composeBody` and Gmail are ever touched.
 */
import { describe, expect, it } from "vitest";

import { composeBody } from "@/backend/gmail/compose";
import { hasBodyContent, mergeAddresses, mergeDraftBody, unwrapBody } from "@/backend/gmail/draft-edit";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("unwrapBody", () => {
  it("strips the house dir=ltr wrapper, returning the inner html", () => {
    const wrapped = `<div dir="ltr" style="max-width:650px"><p>Hi</p><p>There</p></div>`;
    expect(unwrapBody(wrapped)).toBe("<p>Hi</p><p>There</p>");
  });

  it("leaves an already-unwrapped body unchanged", () => {
    expect(unwrapBody("<p>Hi</p><p>There</p>")).toBe("<p>Hi</p><p>There</p>");
  });
});

describe("hasBodyContent", () => {
  it("is false for an empty edit and true when any field has content", () => {
    expect(hasBodyContent({})).toBe(false);
    expect(hasBodyContent({ markdown: "" })).toBe(false);
    expect(hasBodyContent({ text: "hi" })).toBe(true);
    expect(hasBodyContent({ html: "<p>x</p>" })).toBe(true);
  });
});

describe("mergeDraftBody", () => {
  const stored = `<div dir="ltr" style="max-width:650px"><p>Original body.</p></div>`;

  it("replace: returns the new content on its own, dropping the old body", () => {
    const out = mergeDraftBody(stored, "replace", { markdown: "Brand new." });
    expect(out).toEqual({ markdown: "Brand new." });
    expect(JSON.stringify(out)).not.toContain("Original body");
  });

  it("no body content: re-composes the stored html unchanged (header-only edit)", () => {
    const out = mergeDraftBody(stored, "replace", {});
    expect(out).toEqual({ html: stored });
  });

  it("append: puts the new fragment AFTER the existing inner body", () => {
    const out = mergeDraftBody(stored, "append", { text: "P.S. one more." }).html!;
    expect(out).toContain("Original body.");
    expect(out).toContain("P.S. one more.");
    expect(out.indexOf("Original body.")).toBeLessThan(out.indexOf("P.S. one more."));
    // Merged on the UNWRAPPED inner — no nested wrapper.
    expect(out).not.toContain('dir="ltr"');
  });

  it("prepend: puts the new fragment BEFORE the existing inner body", () => {
    const out = mergeDraftBody(stored, "prepend", { text: "Heads up." }).html!;
    expect(out.indexOf("Heads up.")).toBeLessThan(out.indexOf("Original body."));
  });

  it("an appended body still composes to exactly one hidden ref marker", () => {
    // The whole point of merging on the inner: re-composing is idempotent.
    const first = composeBody({ markdown: "Hello Sam." }, { uuid: UUID });
    const merged = mergeDraftBody(first.html, "append", { text: "P.S. ping me." });
    const recomposed = composeBody(merged, { uuid: UUID });
    const markers = recomposed.html.match(/ref:[0-9a-f-]{36}/gi) ?? [];
    expect(markers).toHaveLength(1);
    expect(recomposed.html).not.toMatch(/<p[^>]*>\s*ref:/i);
  });
});

describe("mergeAddresses", () => {
  it("appends a new address", () => {
    expect(mergeAddresses("a@x.com", ["b@y.com"])).toBe("a@x.com, b@y.com");
  });

  it("does not re-add an address already present (case-insensitive, any name form)", () => {
    expect(mergeAddresses('"Alice" <a@x.com>', ["A@X.COM"])).toBe('"Alice" <a@x.com>');
    expect(mergeAddresses("a@x.com, b@y.com", ["b@y.com", "c@z.com"])).toBe("a@x.com, b@y.com, c@z.com");
  });

  it("adds to an empty header and skips entries with no parseable email", () => {
    expect(mergeAddresses("", ["b@y.com"])).toBe("b@y.com");
    expect(mergeAddresses("a@x.com", ["not-an-email"])).toBe("a@x.com");
  });
});
