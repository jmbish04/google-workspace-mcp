import { describe, it, expect } from "vitest";

import { fixMojibake, decodeEntities, sanitizeContent, sanitizeArgs } from "../text-sanitize";

describe("fixMojibake", () => {
  it("repairs an em dash mis-decoded as Windows-1252", () => {
    // "A — B" whose em dash (E2 80 94) was decoded as CP1252 → "â€"".
    expect(fixMojibake("A â€” B")).toBe("A — B");
  });

  it("repairs accented mojibake (café)", () => {
    expect(fixMojibake("cafÃ©")).toBe("café");
  });

  it("leaves already-correct text untouched", () => {
    expect(fixMojibake("A — B, café, 🚀")).toBe("A — B, café, 🚀");
    expect(fixMojibake("plain ascii")).toBe("plain ascii");
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeEntities("5 &lt; 10 &#38; 3 &#x3c; 4")).toBe("5 < 10 & 3 < 4");
  });

  it("leaves unknown entities and non-entity ampersands alone", () => {
    expect(decodeEntities("a &bogus; b")).toBe("a &bogus; b");
    expect(decodeEntities("R&D, AT&T, M&Ms")).toBe("R&D, AT&T, M&Ms");
  });

  it("decodes the long tail a hand-rolled table would miss", () => {
    expect(decodeEntities("½ price: &frac12; &euro;99 &sect;3 &dagger;")).toBe("½ price: ½ €99 §3 †");
  });
});

describe("sanitizeContent", () => {
  it("fixes mojibake and decodes entities in plain text", () => {
    expect(sanitizeContent("R&amp;D â€” done")).toBe("R&D — done");
  });

  it("does NOT decode entities inside real HTML (would corrupt markup)", () => {
    expect(sanitizeContent("<p>Tom &amp; Jerry</p>")).toBe("<p>Tom &amp; Jerry</p>");
  });
});

describe("sanitizeArgs", () => {
  it("sanitizes content-bearing fields but leaves ids/queries/emails alone", () => {
    const out = sanitizeArgs({
      subject: "Q&amp;A â€” notes",
      to: "a&amp;b@x.com",
      query: "name contains 'A &amp; B'",
      fileId: "abc&amp;123",
      values: [["Tom &amp; Jerry", "plain"]],
    });
    expect(out.subject).toBe("Q&A — notes");
    expect(out.to).toBe("a&amp;b@x.com"); // email untouched
    expect(out.query).toBe("name contains 'A &amp; B'"); // query untouched
    expect(out.fileId).toBe("abc&amp;123"); // id untouched
    expect(out.values).toEqual([["Tom & Jerry", "plain"]]); // nested content sanitized
  });

  it("cleans a real Google Doc title (em dash + &amp;)", () => {
    const out = sanitizeArgs({ title: "IB Roofing — Conduit &amp; Warranty (working draft)" });
    expect(out.title).toBe("IB Roofing — Conduit & Warranty (working draft)");
  });

  it("does not mutate the input object", () => {
    const input = { body: "a &amp; b" };
    sanitizeArgs(input);
    expect(input.body).toBe("a &amp; b");
  });
});
