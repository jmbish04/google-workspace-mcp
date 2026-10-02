import { describe, it, expect } from "vitest";

import { hiddenUuidHtml } from "../tracking";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("hiddenUuidHtml", () => {
  it("is white, collapsed, and carries the ref", () => {
    const h = hiddenUuidHtml(UUID);
    expect(h).toContain("color:#ffffff");
    expect(h).toContain(`ref:${UUID}`);
    expect(h).toMatch(/max-height:0|font-size:1px/);
  });

  it("is omitted from the text/plain alternative", () => {
    // Invisible in the HTML part must mean invisible in the text part too —
    // otherwise a plain-text client shows the bare machine id.
    expect(hiddenUuidHtml(UUID)).toContain('data-plaintext="omit"');
  });
});
