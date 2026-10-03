import { describe, it, expect } from "vitest";

import { composeBody } from "@/backend/gmail/compose";
import { htmlToPlate, plateToHtml, type PlateValue } from "../plate-html";

describe("plateToHtml", () => {
  it("emits clean semantic tags for paragraphs, marks and links", () => {
    const value: PlateValue = [
      { type: "p", children: [{ text: "Hello " }, { text: "there", bold: true }, { text: "." }] },
      { type: "p", children: [{ type: "a", url: "https://a.b", children: [{ text: "link" }] }] },
    ];
    const html = plateToHtml(value);
    expect(html).toBe('<p>Hello <strong>there</strong>.</p><p><a href="https://a.b">link</a></p>');
  });

  it("regroups Plate's indent-based list blocks into real <ul>/<ol>", () => {
    // Plate stores a list item as an ordinary block carrying listStyleType +
    // indent, so without this regrouping an edited list would send as prose.
    const value: PlateValue = [
      { type: "p", indent: 1, listStyleType: "disc", children: [{ text: "one" }] },
      { type: "p", indent: 2, listStyleType: "disc", children: [{ text: "nested" }] },
      { type: "p", indent: 1, listStyleType: "disc", children: [{ text: "two" }] },
    ];
    expect(plateToHtml(value)).toBe("<ul><li>one</li><ul><li>nested</li></ul><li>two</li></ul>");
  });

  it("uses <ol> for a numbered list", () => {
    const value: PlateValue = [{ type: "p", indent: 1, listStyleType: "decimal", children: [{ text: "first" }] }];
    expect(plateToHtml(value)).toBe("<ol><li>first</li></ol>");
  });

  it("escapes text so an email body cannot inject markup", () => {
    expect(plateToHtml([{ type: "p", children: [{ text: "<script>x</script>" }] }])).toBe(
      "<p>&lt;script&gt;x&lt;/script&gt;</p>",
    );
  });
});

describe("htmlToPlate", () => {
  it("unwraps the Gmail compose wrapper and drops its blank spacer divs", () => {
    const html = '<div dir="ltr" style="x"><div>One.</div><div><br></div><div>Two.</div></div>';
    expect(htmlToPlate(html)).toEqual([
      { type: "p", children: [{ text: "One." }] },
      { type: "p", children: [{ text: "Two." }] },
    ]);
  });

  it("drops hidden machine markers so they never become editable text", () => {
    // The reference id and the authorship watermark are regenerated on send;
    // if they reached the editor the human would see and could mangle them.
    const html =
      '<div dir="ltr"><div>Hi<span data-plaintext="omit"> [authored v1 x 0 y]</span></div>' +
      '<div data-plaintext="omit">ref:123e4567-e89b-42d3-a456-426614174000</div></div>';
    expect(htmlToPlate(html)).toEqual([{ type: "p", children: [{ text: "Hi" }] }]);
  });

  it("flattens nested lists back into indented blocks", () => {
    const out = htmlToPlate("<ul><li>one<ul><li>deep</li></ul></li><li>two</li></ul>");
    expect(out).toEqual([
      { type: "p", indent: 1, listStyleType: "disc", children: [{ text: "one" }] },
      { type: "p", indent: 2, listStyleType: "disc", children: [{ text: "deep" }] },
      { type: "p", indent: 1, listStyleType: "disc", children: [{ text: "two" }] },
    ]);
  });

  it("keeps marks and link targets", () => {
    const out = htmlToPlate('<p>a <strong>b</strong> <a href="https://x.y">c</a></p>');
    expect(out[0].children).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { type: "a", url: "https://x.y", children: [{ text: "c" }] },
    ]);
  });
});

describe("round trip through the send pipeline", () => {
  const UUID = "123e4567-e89b-42d3-a456-426614174000";

  it("an edit survives html → Plate → html → Gmail HTML without losing structure", () => {
    // This is the studio's whole contract: what the human edits is what gets
    // sent. A loss here would silently drop a bullet or a link from real mail.
    const sent = composeBody(
      { markdown: "Hi **Bob**,\n\n- one\n- two\n\nSee [the quote](https://x.y)." },
      { uuid: UUID },
    ).html;
    const edited = plateToHtml(htmlToPlate(sent));
    const resent = composeBody({ html: edited }, { uuid: UUID });

    expect(resent.html).toMatch(/<strong[^>]*>Bob<\/strong>/);
    expect(resent.html).toMatch(/<li[^>]*>one<\/li>/);
    expect(resent.html).toMatch(/<li[^>]*>two<\/li>/);
    expect(resent.html).toMatch(/<a[^>]*href="https:\/\/x\.y"/);
    expect(resent.html.split("ref:").length - 1).toBe(1);
    expect(resent.text).toContain("Hi Bob,");
  });

  it("is stable: editing twice with no changes does not drift", () => {
    const once = plateToHtml(htmlToPlate(composeBody({ markdown: "A.\n\n- x" }, { uuid: UUID }).html));
    const twice = plateToHtml(htmlToPlate(composeBody({ html: once }, { uuid: UUID }).html));
    expect(twice).toBe(once);
  });
});
