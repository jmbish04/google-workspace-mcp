import { describe, it, expect } from "vitest";

import { parseSheetRefs, buildSheetJson } from "../sheet-export";

const ID1 = "1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7Q8r";
const ID2 = "9Z8y7X6w5V4u3T2s1R0q9P8o7N6m5L4k3J2i";

describe("parseSheetRefs", () => {
  it("accepts a single id or url", () => {
    expect(parseSheetRefs(ID1)).toEqual([{ requested: ID1, id: ID1 }]);
  });

  it("extracts ids from a mixed array of urls and bare ids", () => {
    const out = parseSheetRefs([
      `https://docs.google.com/spreadsheets/d/${ID1}/edit#gid=0`,
      ID2,
    ]);
    expect(out.map((r) => r.id)).toEqual([ID1, ID2]);
    expect(out[0].requested).toContain("docs.google.com"); // original string preserved
  });

  it("drops blanks and de-duplicates by id (url + bare id for the same sheet)", () => {
    const out = parseSheetRefs([
      `https://drive.google.com/file/d/${ID1}/view`,
      "   ",
      ID1, // same sheet as the url above
      ID2,
    ]);
    expect(out.map((r) => r.id)).toEqual([ID1, ID2]);
  });
});

describe("buildSheetJson", () => {
  const tabs = [
    { title: "People", values: [["name", "age"], ["Ada", "36"], ["Alan", "41"]] },
    { title: "Empty", values: [] },
  ];

  it("records shape keys each row by the header row", () => {
    const { json, tabCount } = buildSheetJson("sid", "Book", tabs, "records", "2026-01-01T00:00:00Z");
    expect(tabCount).toBe(2);
    const t = json.tabs as Record<string, unknown>;
    expect(t.People).toEqual([
      { name: "Ada", age: "36" },
      { name: "Alan", age: "41" },
    ]);
    expect(t.Empty).toEqual([]);
    expect(json.spreadsheetId).toBe("sid");
  });

  it("values shape returns raw 2-D arrays", () => {
    const { json } = buildSheetJson("sid", "Book", tabs, "values", "2026-01-01T00:00:00Z");
    expect((json.tabs as Record<string, unknown>).People).toEqual(tabs[0].values);
  });

  it("synthesizes keys for blank header cells", () => {
    const t = [{ title: "T", values: [["a", ""], ["1", "2"]] }];
    const { json } = buildSheetJson("sid", "B", t, "records", "2026-01-01T00:00:00Z");
    expect((json.tabs as Record<string, unknown>).T).toEqual([{ a: "1", col2: "2" }]);
  });
});
