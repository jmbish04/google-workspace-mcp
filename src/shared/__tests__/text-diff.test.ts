import { describe, it, expect } from "vitest";

import { diffSummary, diffWords } from "../text-diff";

describe("diffWords", () => {
  it("marks only the words that changed, not the whole line", () => {
    const parts = diffWords("The price is $4,000 today.", "The price is $4,500 today.");
    expect(parts.filter((p) => p.op !== "same").map((p) => p.value.trim())).toEqual(["000", "500"]);
    expect(parts.map((p) => (p.op === "removed" ? "" : p.value)).join("")).toBe("The price is $4,500 today.");
  });

  it("round-trips: the kept + removed parts rebuild the original", () => {
    const before = "one two three";
    const after = "one three four";
    const parts = diffWords(before, after);
    expect(parts.filter((p) => p.op !== "added").map((p) => p.value).join("")).toBe(before);
    expect(parts.filter((p) => p.op !== "removed").map((p) => p.value).join("")).toBe(after);
  });

  it("reports pure insertion and pure deletion", () => {
    expect(diffWords("", "new").some((p) => p.op === "added")).toBe(true);
    expect(diffWords("gone", "").some((p) => p.op === "removed")).toBe(true);
  });

  it("falls back to a wholesale replacement rather than hanging on a huge input", () => {
    // The LCS table is O(n·m); past the guard it must degrade, not block the page.
    const big = "word ".repeat(3000);
    const parts = diffWords(big, `${big}tail`, 100);
    expect(parts.map((p) => p.op)).toEqual(["removed", "added"]);
  });
});

describe("diffSummary", () => {
  it("counts words added and removed", () => {
    expect(diffSummary(diffWords("a b c", "a x y z"))).toEqual({ added: 3, removed: 2 });
  });
});
