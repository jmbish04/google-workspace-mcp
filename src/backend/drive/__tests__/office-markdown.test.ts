import { describe, it, expect } from "vitest";

import { parseCsv, csvToMarkdown, slidesTextToMarkdown, isConvertibleOffice } from "../office-markdown";

describe("isConvertibleOffice", () => {
  it("recognizes docx/xlsx/pptx", () => {
    expect(isConvertibleOffice("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
    expect(isConvertibleOffice("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
    expect(isConvertibleOffice("application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe(true);
    expect(isConvertibleOffice("application/pdf")).toBe(false);
  });
});

describe("parseCsv", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });
  it("handles quoted fields with commas and newlines", () => {
    expect(parseCsv('name,note\n"Smith, Jane","line1\nline2"')).toEqual([
      ["name", "note"],
      ["Smith, Jane", "line1\nline2"],
    ]);
  });
  it("handles escaped quotes", () => {
    expect(parseCsv('a\n"he said ""hi"""')).toEqual([["a"], ['he said "hi"']]);
  });
  it("handles CRLF line endings and trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("csvToMarkdown", () => {
  it("renders a pipe table with a header separator", () => {
    const md = csvToMarkdown("h1,h2\nv1,v2");
    expect(md).toBe("| h1 | h2 |\n| --- | --- |\n| v1 | v2 |");
  });
  it("escapes pipes in cells", () => {
    const md = csvToMarkdown("a\nx|y");
    expect(md).toContain("x\\|y");
  });
  it("pads short rows to the table width", () => {
    const md = csvToMarkdown("a,b,c\n1");
    expect(md.split("\n")[2]).toBe("| 1 |  |  |");
  });
  it("returns empty for empty input", () => {
    expect(csvToMarkdown("")).toBe("");
  });
});

describe("slidesTextToMarkdown", () => {
  it("promotes non-indented lines to ## headings", () => {
    const md = slidesTextToMarkdown("Title Slide\n  bullet one\nSecond Slide");
    expect(md).toContain("## Title Slide");
    expect(md).toContain("## Second Slide");
    expect(md).toContain("  bullet one");
  });
});
