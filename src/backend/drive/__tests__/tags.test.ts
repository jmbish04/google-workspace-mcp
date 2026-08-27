import { describe, it, expect } from "vitest";

import { normalizeTagName, tagToken } from "../tags";

describe("normalizeTagName", () => {
  it("upper-snakes arbitrary labels", () => {
    expect(normalizeTagName("Roof Warranty")).toBe("ROOF_WARRANTY");
    expect(normalizeTagName("  q4-2026 report ")).toBe("Q4_2026_REPORT");
    expect(normalizeTagName("café & co")).toBe("CAF_CO");
  });
  it("collapses runs and trims leading/trailing underscores", () => {
    expect(normalizeTagName("--a__b--")).toBe("A_B");
    expect(normalizeTagName("#Already_TAG")).toBe("ALREADY_TAG");
  });
  it("caps at 60 chars", () => {
    expect(normalizeTagName("x".repeat(100)).length).toBe(60);
  });
  it("tagToken prefixes with #", () => {
    expect(tagToken("ROOF_WARRANTY")).toBe("#ROOF_WARRANTY");
  });
});
