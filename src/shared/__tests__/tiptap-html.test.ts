import { describe, it, expect } from "vitest";

import { composeBody } from "@/backend/gmail/compose";
import { htmlToTiptap, tiptapToHtml, type TiptapDoc } from "../tiptap-html";

describe("tiptapToHtml", () => {
  it("emits clean semantic tags for paragraphs, marks and links", () => {
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "there", marks: [{ type: "bold" }] },
            { type: "text", text: "." },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://a.b" } }] }],
        },
      ],
    };
    expect(tiptapToHtml(doc)).toBe('<p>Hello <strong>there</strong>.</p><p><a href="https://a.b">link</a></p>');
  });

  it("serialises a bullet list as <ul>/<li> with the item text unwrapped", () => {
    // ProseMirror nests a paragraph inside every list item; without the unwrap
    // an edited list would send as `<li><p>one</p></li>` and style oddly.
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
          ],
        },
      ],
    };
    expect(tiptapToHtml(doc)).toBe("<ul><li>one</li><li>two</li></ul>");
  });

  it("uses <ol> for an ordered list", () => {
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] }] },
      ],
    };
    expect(tiptapToHtml(doc)).toBe("<ol><li>first</li></ol>");
  });

  it("escapes text so an email body cannot inject markup", () => {
    const doc: TiptapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "<script>x</script>" }] }] };
    expect(tiptapToHtml(doc)).toBe("<p>&lt;script&gt;x&lt;/script&gt;</p>");
  });

  it("drops editor decoration (highlight, text-align, task-list chrome) so none leaks into the wire", () => {
    // The editor can produce these; an email body must not carry background
    // colours, alignment styles or checkboxes. The content survives, the
    // styling does not, and no class/style/data-* attribute reaches the output.
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { textAlign: "center" },
          content: [{ type: "text", text: "hi", marks: [{ type: "highlight", attrs: { color: "#ff0" } }, { type: "bold" }] }],
        },
        {
          type: "taskList",
          content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "todo" }] }] }],
        },
      ],
    };
    const html = tiptapToHtml(doc);
    expect(html).toBe("<p><strong>hi</strong></p><ul><li>todo</li></ul>");
    expect(html).not.toMatch(/style=|class=|data-|background|text-align|checkbox/i);
  });
});

describe("htmlToTiptap", () => {
  it("unwraps the Gmail compose wrapper and drops its blank spacer divs", () => {
    const html = '<div dir="ltr" style="x"><div>One.</div><div><br></div><div>Two.</div></div>';
    const doc = htmlToTiptap(html);
    expect(doc.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "One." }] },
      { type: "paragraph", content: [{ type: "text", text: "Two." }] },
    ]);
  });

  it("drops hidden machine markers so they never become editable text", () => {
    // The reference id and the authorship watermark are regenerated on send;
    // if they reached the editor the human would see and could mangle them.
    const html =
      '<div dir="ltr"><div>Hi<span data-plaintext="omit"> [authored v1 x 0 y]</span></div>' +
      '<div data-plaintext="omit">ref:123e4567-e89b-42d3-a456-426614174000</div></div>';
    expect(htmlToTiptap(html).content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }]);
  });

  it("keeps marks and link targets", () => {
    const doc = htmlToTiptap('<p>a <strong>b</strong> <a href="https://x.y">c</a></p>');
    const para = doc.content?.[0];
    expect(para?.type).toBe("paragraph");
    expect(para?.content?.[0]).toEqual({ type: "text", text: "a " });
    expect(para?.content?.[1]).toEqual({ type: "text", text: "b", marks: [{ type: "bold" }] });
    const link = para?.content?.find((n) => n.marks?.some((m) => m.type === "link"));
    expect(link?.text).toBe("c");
    expect(link?.marks?.find((m) => m.type === "link")?.attrs?.href).toBe("https://x.y");
  });
});

describe("round trip through the send pipeline", () => {
  const UUID = "123e4567-e89b-42d3-a456-426614174000";

  it("an edit survives html → Tiptap → html → Gmail HTML without losing structure", () => {
    // This is the studio's whole contract: what the human edits is what gets
    // sent. A loss here would silently drop a bullet or a link from real mail.
    const sent = composeBody(
      { markdown: "Hi **Bob**,\n\n- one\n- two\n\nSee [the quote](https://x.y)." },
      { uuid: UUID },
    ).html;
    const edited = tiptapToHtml(htmlToTiptap(sent));
    const resent = composeBody({ html: edited }, { uuid: UUID });

    expect(resent.html).toMatch(/<strong[^>]*>Bob<\/strong>/);
    expect(resent.html).toMatch(/<li[^>]*>one<\/li>/);
    expect(resent.html).toMatch(/<li[^>]*>two<\/li>/);
    expect(resent.html).toMatch(/<a[^>]*href="https:\/\/x\.y"/);
    expect(resent.html.split("ref:").length - 1).toBe(1);
    expect(resent.text).toContain("Hi Bob,");
  });

  it("is stable: editing twice with no changes does not drift", () => {
    const once = tiptapToHtml(htmlToTiptap(composeBody({ markdown: "A.\n\n- x" }, { uuid: UUID }).html));
    const twice = tiptapToHtml(htmlToTiptap(composeBody({ html: once }, { uuid: UUID }).html));
    expect(twice).toBe(once);
  });
});
