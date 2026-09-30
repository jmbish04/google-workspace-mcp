import { describe, it, expect } from "vitest";

import { buildAuthoredBody, verifyAuthoredHtml, GMAIL_NATIVE_STYLE } from "../authored-html";
import { composeBody } from "../compose";
import { embedUuid } from "../tracking";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const AUTHOR = "justin@126colby.com";

async function build(input: { html?: string; markdown?: string; text?: string }) {
  return buildAuthoredBody({ ...input, uuid: UUID, author: AUTHOR, keyHex: KEY });
}

/** What Gmail produces when a counterparty replies above/inside the quote. */
function gmailQuote(originalHtml: string, replyAbove = "<div>Sounds good.</div>") {
  return (
    `<div dir="ltr">${replyAbove}</div><br><div class="gmail_quote">` +
    `<div dir="ltr" class="gmail_attr">On Mon, Justin wrote:<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex">${originalHtml}</blockquote></div>`
  );
}

describe("buildAuthoredBody — native Gmail shape", () => {
  it("wraps in Gmail's compose style and uses div + <div><br></div> paragraphs, never <p>", async () => {
    const { html } = await build({ markdown: "First para with **bold** and [a link](https://example.com).\n\nSecond para." });
    expect(html.startsWith(`<div dir="ltr" style="${GMAIL_NATIVE_STYLE}">`)).toBe(true);
    expect(html).not.toMatch(/<p[\s>]/);
    expect(html).toContain("<div><br></div>");
    expect(html).toMatch(/<strong[^>]*>bold<\/strong>/);
    expect(html).toMatch(/<a href="https:\/\/example.com"[^>]*>a link<\/a>/);
  });

  it("keeps the searchable ref:<uuid> hidden in white, and in the text part", async () => {
    const { html, text } = await build({ text: "Hello" });
    expect(html).toContain(`ref:${UUID}`);
    expect(html).toMatch(/color:#ffffff[^"]*"[^>]*>ref:/);
    expect(text).toContain(`ref:${UUID}`);
  });

  it("text part is clean: no tags, no legend, no markdown, no entities", async () => {
    const { text } = await build({ markdown: "Tom & Jerry **agree**.\n\nNext." });
    expect(text).not.toMatch(/\[authored v1/);
    expect(text).not.toContain("Authorship watermark");
    expect(text).not.toContain("**");
    expect(text).not.toContain("&amp;");
    expect(text).toContain("Tom & Jerry agree.");
  });

  it("the draft pipeline's own text/plain part (derived from html) leaks no tags or legend", async () => {
    const { html } = await build({ markdown: "Hello **there**.\n\n- one" });
    const { text } = composeBody({ html });
    expect(text).not.toMatch(/authored v1|Authorship watermark/);
    expect(text).toContain("Hello there.");
    expect(text).toContain(`ref:${UUID}`);
  });

  it("escapes plain text input instead of rendering it as HTML", async () => {
    const { html } = await build({ text: "a <b>not bold</b>\nline two" });
    expect(html).toContain("a &lt;b&gt;not bold&lt;/b&gt;<br>line two");
  });

  it("signs each paragraph and each list item", async () => {
    const r = await build({ markdown: "Intro.\n\n- one\n- two\n\nOutro." });
    expect(r.signedBlocks).toBe(4);
  });

  it("does not get a second ref when passed through the existing draft pipeline", async () => {
    const { html } = await build({ text: "Hello" });
    const stamped = embedUuid({ html }, UUID);
    expect(stamped.html!.split(`ref:${UUID}`).length - 1).toBe(1);
  });
});

describe("verifyAuthoredHtml", () => {
  it("verifies an untouched message", async () => {
    const { html } = await build({ markdown: "We agreed on **$4,000**.\n\nWork starts Monday." });
    const r = await verifyAuthoredHtml(html, KEY);
    expect(r.signed.map((b) => b.verdict)).toEqual(["verified", "verified"]);
    expect(r.unmarked).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it("still verifies after the Worker's draft pipeline (sanitize + juice) re-serialises it", async () => {
    const { html } = await build({ markdown: "It's Tom & Jerry's \"deal\".\n\n- a\n- b" });
    const shipped = composeBody({ html }).html!;
    const r = await verifyAuthoredHtml(shipped, KEY);
    expect(r.signed.length).toBe(3);
    expect(r.signed.every((b) => b.verdict === "verified")).toBe(true);
  });

  it("flags text a counterparty typed INLINE inside the quoted original", async () => {
    const { html } = await build({ markdown: "Please confirm the $4,000 price.\n\nWork starts Monday." });
    // Counterparty clicks into the quote and types between Justin's paragraphs.
    const tampered = html.replace("<div><br></div>", "<div><br></div><div>&gt;&gt; We never agreed to that price.</div>");
    const r = await verifyAuthoredHtml(gmailQuote(tampered), KEY);
    expect(r.signed.every((b) => b.verdict === "verified")).toBe(true);
    expect(r.unmarked).toEqual([">> We never agreed to that price."]);
    expect(r.summary).toMatch(/written by someone else/);
  });

  it("does not blame the counterparty's own reply ABOVE the quote", async () => {
    const { html } = await build({ text: "One.\n\nTwo." });
    const r = await verifyAuthoredHtml(gmailQuote(html, "<div>My normal reply.</div>"), KEY);
    expect(r.unmarked).toEqual([]);
  });

  it("detects a signed paragraph whose words were changed", async () => {
    const { html } = await build({ text: "The price is $4,000.\n\nThanks." });
    const r = await verifyAuthoredHtml(html.replace("$4,000", "$40,000"), KEY);
    expect(r.signed.map((b) => b.verdict)).toEqual(["altered", "verified"]);
  });

  it("detects a changed link target even when the text is identical", async () => {
    const { html } = await build({ markdown: "Pay [here](https://pay.example.com)." });
    const r = await verifyAuthoredHtml(html.replace("https://pay.example.com", "https://evil.example.com"), KEY);
    expect(r.signed[0].verdict).toBe("altered");
  });

  it("detects a signed paragraph deleted from the quote", async () => {
    const { html } = await build({ text: "One.\n\nTwo.\n\nThree." });
    const root = html.replace(/<div>Two\.<span[^>]*>[^<]*<\/span><\/div>/, "");
    const r = await verifyAuthoredHtml(root, KEY);
    expect(r.missing).toEqual([{ uuid: UUID, index: 1 }]);
  });

  it("a forged tag (wrong key) never verifies", async () => {
    const { html } = await build({ text: "Hello." });
    const r = await verifyAuthoredHtml(html, OTHER_KEY);
    expect(r.signed[0].verdict).toBe("altered");
  });

  it("no tags → says authorship is undetermined, not 'not the sender'", async () => {
    const r = await verifyAuthoredHtml("<div>plain mail</div>", KEY);
    expect(r.signed).toEqual([]);
    expect(r.unmarked).toEqual([]);
    expect(r.summary).toMatch(/NOT evidence either way/);
  });
});
