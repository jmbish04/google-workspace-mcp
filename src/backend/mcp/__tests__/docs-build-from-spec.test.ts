import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));

import { TOOLS } from "../tools";

const ctx = { env: {} as Env, sub: "s1" };
const tool = TOOLS.find((t) => t.name === "docs_build_from_spec")!;

const p = (start: number, text: string, style = "NORMAL_TEXT") => ({
  startIndex: start,
  endIndex: start + text.length,
  paragraph: { elements: [{ startIndex: start, endIndex: start + text.length, textRun: { content: text, textStyle: {} } }], paragraphStyle: { namedStyleType: style } },
});
const docOf = (revisionId: string, content: any[]) => ({
  documentId: "doc1",
  revisionId,
  tabs: [{ tabProperties: { tabId: "t.0", title: "Tab 1" }, documentTab: { body: { content: [{ endIndex: 1, sectionBreak: {} }, ...content] } } }],
});

const emptyDoc = docOf("rev-empty", [p(1, "\n")]);
// "Intro\n" [1,7) "Experience\n" (HEADING_2) [7,18) "Old job\n" [18,26)
const textDoc = docOf("rev-text", [p(1, "Intro\n"), p(7, "Experience\n", "HEADING_2"), p(18, "Old job\n")]);
// After inserting "New role\n" (9 units) at 18.
const textDocAfter = docOf("rev-text-2", [p(1, "Intro\n"), p(7, "Experience\n", "HEADING_2"), p(18, "New role\n"), p(27, "Old job\n")]);

let gets: unknown[];
let fetchSpy: ReturnType<typeof vi.spyOn>;
const posts = () => fetchSpy.mock.calls.filter(([, init]: any[]) => (init as RequestInit)?.method === "POST");
const postBody = (n = 0) => JSON.parse((posts()[n][1] as RequestInit).body as string);

beforeEach(() => {
  vi.restoreAllMocks();
  gets = [];
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ documentId: "doc1", replies: [], writeControl: { requiredRevisionId: "rev-new" } }), { status: 200 });
    }
    const next = gets.length > 1 ? gets.shift() : gets[0];
    return new Response(JSON.stringify(next), { status: 200 });
  });
});

const resumeLike = {
  document: { pageMode: "PAGES", margins: { top: 36, bottom: 36, left: 36, right: 36 } },
  blocks: [
    { type: "heading", level: 1, text: "Name" },
    { type: "table", columns: 2, rows: [{ cells: [{ blocks: [{ type: "paragraph", text: "L" }] }, { blocks: [{ type: "list", items: ["a"] }] }] }] },
  ],
};

describe("docs_build_from_spec (C3)", () => {
  it("create: one guarded batch on an empty tab, page setup first, then a re-read", async () => {
    gets = [emptyDoc, { ...emptyDoc, revisionId: "rev-new" }];
    const args = tool.inputSchema.parse({ documentId: "doc1", mode: "create", spec: resumeLike });
    const { result } = (await tool.run(ctx, args)) as { result: any };
    expect(posts()).toHaveLength(1);
    const body = postBody();
    expect(body.writeControl).toEqual({ requiredRevisionId: "rev-empty" });
    expect(Object.keys(body.requests[0])[0]).toBe("updateDocumentStyle");
    expect(body.requests[0].updateDocumentStyle.tabId).toBe("t.0");
    expect(result).toMatchObject({ ok: true, mode: "create", tabId: "t.0", insertAt: 1, revisionId: "rev-new" });
    expect(result.requestCount).toBe(body.requests.length);
  });

  it("create: refuses a tab that is not empty, writing nothing", async () => {
    gets = [textDoc];
    const args = tool.inputSchema.parse({ documentId: "doc1", spec: resumeLike });
    await expect(tool.run(ctx, args)).rejects.toThrow(/needs an empty tab/);
    expect(posts()).toHaveLength(0);
  });

  it("insert after a heading: new text lands before the next paragraph, stays NORMAL_TEXT, and the rest is unchanged", async () => {
    gets = [textDoc, textDocAfter];
    const args = tool.inputSchema.parse({
      documentId: "doc1",
      mode: "insert",
      anchor: { heading: "experience" },
      spec: { document: { pageMode: "PAGES" }, blocks: [{ type: "paragraph", text: "New role" }] },
    });
    const { result } = (await tool.run(ctx, args)) as { result: any };
    const reqs = postBody().requests;
    expect(reqs[0]).toEqual({ insertText: { location: { index: 18, tabId: "t.0" }, text: "New role\n" } });
    expect(reqs.some((r: any) => r.updateDocumentStyle)).toBe(false); // page setup only in create mode
    const ps = reqs.find((r: any) => r.updateParagraphStyle).updateParagraphStyle;
    expect(ps.paragraphStyle.namedStyleType).toBe("NORMAL_TEXT");
    expect(ps.range).toMatchObject({ startIndex: 18, endIndex: 27 });
    expect(result.preserved).toEqual({ before: true, after: true });
    expect(result.notes.join(" ")).toMatch(/page setup/i);
  });

  it("insert: reports drift when the re-read text around the insert changed", async () => {
    const drifted = docOf("rev-x", [p(1, "Intro\n"), p(7, "Experience\n", "HEADING_2"), p(18, "New role\n"), p(27, "Old JOB\n")]);
    gets = [textDoc, drifted];
    const args = tool.inputSchema.parse({ documentId: "doc1", mode: "insert", anchor: { text: "Experience" }, spec: { blocks: [{ type: "paragraph", text: "New role" }] } });
    const { result } = (await tool.run(ctx, args)) as { result: any };
    expect(result.preserved).toEqual({ before: true, after: false });
  });

  it("insert after the last paragraph adds its own paragraph first", async () => {
    gets = [textDoc, textDoc];
    const args = tool.inputSchema.parse({ documentId: "doc1", mode: "insert", anchor: { text: "Old job" }, spec: { blocks: [{ type: "paragraph", text: "Tail" }] } });
    await tool.run(ctx, args);
    const reqs = postBody().requests;
    expect(reqs[0]).toEqual({ insertText: { location: { index: 25, tabId: "t.0" }, text: "\n" } });
    expect(reqs[1]).toEqual({ insertText: { location: { index: 26, tabId: "t.0" }, text: "Tail" } });
  });

  it("a concurrent edit between read and write gives REVISION_CONFLICT and writes nothing", async () => {
    gets = [emptyDoc];
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: { code: 400, status: "FAILED_PRECONDITION", message: "The required revision ID does not match" } }), { status: 400 });
      }
      return new Response(JSON.stringify(emptyDoc), { status: 200 });
    });
    const args = tool.inputSchema.parse({ documentId: "doc1", spec: resumeLike });
    const { result } = (await tool.run(ctx, args)) as { result: any };
    expect(result).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    expect(posts()).toHaveLength(1);
  });

  it("dryRun returns the compiled batch and writes nothing", async () => {
    gets = [emptyDoc];
    const args = tool.inputSchema.parse({ documentId: "doc1", spec: resumeLike, dryRun: true });
    const { result } = (await tool.run(ctx, args)) as { result: any };
    expect(posts()).toHaveLength(0);
    expect(result.dryRun).toBe(true);
    expect(result.requests.length).toBe(result.requestCount);
  });

  it("rejects an invalid spec with the Zod path", () => {
    expect(() => tool.inputSchema.parse({ documentId: "doc1", spec: { blocks: [{ type: "paragraph", text: "x", color: "nope" }] } })).toThrow(
      /blocks.*0.*color|Unknown color/,
    );
  });
});
