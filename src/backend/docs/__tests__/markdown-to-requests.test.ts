import { describe, it, expect } from "vitest";

import { markdownToRequests } from "../markdown-to-requests";

describe("markdownToRequests", () => {
  it("maps a heading to HEADING_1 at baseIndex", () => {
    const reqs = markdownToRequests("# Title\n\nHello");
    const insert = reqs[0] as any;
    expect(insert.insertText.location.index).toBe(1);
    expect(insert.insertText.text).toContain("Title");
    const h = reqs.find((r: any) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === "HEADING_1");
    expect(h).toBeTruthy();
  });

  it("styles inline bold", () => {
    const reqs = markdownToRequests("Hello **world**");
    expect(reqs.some((r: any) => r.updateTextStyle?.textStyle?.bold)).toBe(true);
  });

  it("bullets list items", () => {
    const reqs = markdownToRequests("- a\n- b");
    expect(reqs.filter((r: any) => r.createParagraphBullets).length).toBe(2);
  });

  it("appends at a non-1 baseIndex", () => {
    const reqs = markdownToRequests("Appended", 42);
    expect((reqs[0] as any).insertText.location.index).toBe(42);
  });

  it("returns nothing for empty markdown", () => {
    expect(markdownToRequests("   ")).toEqual([]);
  });
});
