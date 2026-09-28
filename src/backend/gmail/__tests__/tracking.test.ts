import { describe, it, expect } from "vitest";

import { embedUuid, hiddenUuidHtml } from "../tracking";

const UUID = "abc-123";

describe("hiddenUuidHtml", () => {
  it("is white, collapsed, and carries the ref", () => {
    const h = hiddenUuidHtml(UUID);
    expect(h).toContain("color:#ffffff");
    expect(h).toContain("ref:abc-123");
    expect(h).toMatch(/max-height:0|font-size:1px/);
  });
});

describe("embedUuid", () => {
  it("appends the hidden div to an HTML body", () => {
    const out = embedUuid({ html: "<p>hi</p>" }, UUID);
    expect(out.html).toContain("<p>hi</p>");
    expect(out.html).toContain("ref:abc-123");
    expect(out.text).toBeUndefined();
  });
  it("appends the hidden div to a markdown body", () => {
    const out = embedUuid({ markdown: "# hi" }, UUID);
    expect(out.markdown).toContain("# hi");
    expect(out.markdown).toContain("ref:abc-123");
  });
  it("appends a plain ref line to a text-only body (can't hide in plain text)", () => {
    const out = embedUuid({ text: "hi" }, UUID);
    expect(out.text).toBe("hi\n\nref:abc-123");
    expect(out.html).toBeUndefined();
  });
});
