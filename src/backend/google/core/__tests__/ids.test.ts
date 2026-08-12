import { describe, it, expect } from "vitest";

import { extractGoogleId, parseDriveRefs } from "../ids";

const ID1 = "1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7Q8r";
const ID2 = "9Z8y7X6w5V4u3T2s1R0q9P8o7N6m5L4k3J2i";

describe("extractGoogleId", () => {
  it("passes a bare id through", () => {
    expect(extractGoogleId(ID1)).toBe(ID1);
  });
  it("extracts from Docs / Sheets / file / folders / open?id urls", () => {
    expect(extractGoogleId(`https://docs.google.com/document/d/${ID1}/edit`)).toBe(ID1);
    expect(extractGoogleId(`https://docs.google.com/spreadsheets/d/${ID1}/edit#gid=0`)).toBe(ID1);
    expect(extractGoogleId(`https://drive.google.com/file/d/${ID1}/view`)).toBe(ID1);
    expect(extractGoogleId(`https://drive.google.com/drive/folders/${ID1}`)).toBe(ID1);
    expect(extractGoogleId(`https://drive.google.com/open?id=${ID1}`)).toBe(ID1);
  });
});

describe("parseDriveRefs", () => {
  it("normalizes a single id or url", () => {
    expect(parseDriveRefs(ID1)).toEqual([{ requested: ID1, id: ID1 }]);
  });

  it("handles a mixed array of urls and bare ids", () => {
    const out = parseDriveRefs([`https://docs.google.com/document/d/${ID1}/edit`, ID2]);
    expect(out.map((r) => r.id)).toEqual([ID1, ID2]);
    expect(out[0].requested).toContain("document/d/"); // original preserved
  });

  it("drops blanks/non-strings and dedupes by id", () => {
    const out = parseDriveRefs([
      `https://drive.google.com/file/d/${ID1}/view`,
      "  ",
      ID1, // same sheet/doc as the url above
      ID2,
    ]);
    expect(out.map((r) => r.id)).toEqual([ID1, ID2]);
  });
});
