import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));

import { appendInsertPoint } from "@/backend/docs/spec/anchor";
import { compileSpec } from "@/backend/docs/spec/compile";
import { buildTableFactorySpec } from "@/backend/docs/table-spec";
import { TOOLS } from "../tools";

const tool = TOOLS.find((t) => t.name === "table_factory")!;
const ctx = { env: {} as Env, sub: "s1" };
const p = (start: number, text: string) => ({
  startIndex: start,
  endIndex: start + text.length,
  paragraph: { elements: [{ startIndex: start, endIndex: start + text.length, textRun: { content: text, textStyle: {} } }] },
});
const doc = { revisionId: "r1", tabs: [{ tabProperties: { tabId: "t.0" }, documentTab: { body: { content: [{ endIndex: 1, sectionBreak: {} }, p(1, "Intro\n")] } } }] };

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.restoreAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) =>
    new Response(JSON.stringify(init?.method === "POST" ? { replies: [], writeControl: { requiredRevisionId: "r2" } } : doc), { status: 200 }),
  );
});

const compiled = (spec: unknown) => compileSpec(spec, { insertAt: 1, tabId: "t.0", trailing: "own" }).requests as any[];

describe("buildTableFactorySpec (C4)", () => {
  it("theme default keeps the old look: dark-blue header, white bold centered text, 1pt black borders", () => {
    const reqs = compiled(buildTableFactorySpec([["A", "B"], ["1", "2"]], {}));
    const cells = reqs.filter((r) => r.updateTableCellStyle).map((r) => r.updateTableCellStyle);
    expect(cells[0].tableCellStyle.backgroundColor.color.rgbColor).toEqual({ red: 0.1216, green: 0.3059, blue: 0.4745 });
    expect(cells[0].tableCellStyle.contentAlignment).toBe("MIDDLE");
    for (const c of cells) expect(c.tableCellStyle.borderTop).toEqual({ width: { magnitude: 1, unit: "PT" }, color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } }, dashStyle: "SOLID" });
    const headerText = reqs.find((r) => r.updateTextStyle?.textStyle?.bold).updateTextStyle;
    expect(headerText.textStyle.foregroundColor.color.rgbColor).toEqual({ red: 1, green: 1, blue: 1 });
    const headerPara = reqs.find((r) => r.updateParagraphStyle?.paragraphStyle?.alignment === "CENTER");
    expect(headerPara).toBeTruthy();
  });

  it("makes a borderless 1x2 layout table with fixed widths and no header row", () => {
    const reqs = compiled(buildTableFactorySpec([["Left", "Right"]], { borders: "none", header: false, columnWidths: [180, 360] }));
    const cells = reqs.filter((r) => r.updateTableCellStyle).map((r) => r.updateTableCellStyle.tableCellStyle);
    expect(cells.every((c) => c.borderLeft.width.magnitude === 0 && !c.backgroundColor)).toBe(true);
    const widths = reqs.filter((r) => r.updateTableColumnProperties).map((r) => r.updateTableColumnProperties.tableColumnProperties);
    expect(widths).toEqual([
      { widthType: "FIXED_WIDTH", width: { magnitude: 180, unit: "PT" } },
      { widthType: "FIXED_WIDTH", width: { magnitude: 360, unit: "PT" } },
    ]);
    expect(reqs.some((r) => r.updateTextStyle?.textStyle?.bold)).toBe(false);
  });

  it("applies cell fills, padding and a custom header color", () => {
    const reqs = compiled(buildTableFactorySpec([["H"], ["x"]], { headerFill: "#0f8b7d", fills: [[null], ["#eeeeee"]], padding: 8 }));
    const cells = reqs.filter((r) => r.updateTableCellStyle).map((r) => r.updateTableCellStyle.tableCellStyle);
    expect(cells[0].backgroundColor.color.rgbColor).toEqual({ red: 0.0588, green: 0.5451, blue: 0.4902 });
    expect(cells[1].backgroundColor.color.rgbColor).toEqual({ red: 0.9333, green: 0.9333, blue: 0.9333 });
    expect(cells[1].paddingLeft).toEqual({ magnitude: 8, unit: "PT" });
  });
});

describe("appendInsertPoint", () => {
  it("adds a paragraph after a non-empty last paragraph", () => {
    expect(appendInsertPoint(doc.tabs[0].documentTab.body.content, "t.0")).toMatchObject({
      insertAt: 7,
      trailing: "own",
      prefix: [{ insertText: { location: { index: 6, tabId: "t.0" }, text: "\n" } }],
    });
  });

  it("reuses an empty last paragraph", () => {
    expect(appendInsertPoint([{ endIndex: 1, sectionBreak: {} }, p(1, "\n")], "t.0")).toMatchObject({ insertAt: 1, prefix: [] });
  });
});

describe("table_factory tool (C4)", () => {
  it("writes the whole table in ONE guarded batchUpdate", async () => {
    const args = tool.inputSchema.parse({ documentId: "doc1", data: [["A", "B"], ["1", "2"]] });
    const { result } = (await tool.run(ctx, args)) as { result: any };
    const posts = fetchSpy.mock.calls.filter(([, i]: any[]) => (i as RequestInit)?.method === "POST");
    expect(posts).toHaveLength(1);
    const body = JSON.parse((posts[0][1] as RequestInit).body as string);
    expect(body.writeControl).toEqual({ requiredRevisionId: "r1" });
    expect(body.requests[0]).toEqual({ insertText: { location: { index: 6, tabId: "t.0" }, text: "\n" } });
    expect(body.requests[1]).toMatchObject({ insertTable: { rows: 2, columns: 2 } });
    expect(result).toMatchObject({ ok: true, rows: 2, cols: 2, documentId: "doc1" });
  });
});
