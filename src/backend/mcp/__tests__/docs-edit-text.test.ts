import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));

import { TOOLS } from "../tools";

const docJson = {
  revisionId: "rev-abc",
  tabs: [
    {
      tabProperties: { tabId: "t.0" },
      documentTab: {
        body: {
          content: [
            {
              paragraph: {
                elements: [
                  { startIndex: 1, endIndex: 22, textRun: { content: "Status: the draft is ", textStyle: {} } },
                  { startIndex: 22, endIndex: 38, textRun: { content: "ready for review", textStyle: { bold: true } } },
                  { startIndex: 38, endIndex: 46, textRun: { content: " today.\n", textStyle: {} } },
                ],
              },
            },
          ],
        },
      },
    },
  ],
};

const footnoteDocJson = {
  tabs: [
    {
      tabProperties: { tabId: "t.0" },
      documentTab: {
        body: {
          content: [
            {
              paragraph: {
                elements: [
                  { startIndex: 1, endIndex: 10, textRun: { content: "the claim", textStyle: {} } },
                  { startIndex: 10, endIndex: 11, footnoteReference: { footnoteId: "fn1" } },
                  { startIndex: 11, endIndex: 21, textRun: { content: " is valid\n", textStyle: {} } },
                ],
              },
            },
          ],
        },
      },
    },
  ],
};

/** Same paragraph, but the target run is a pending tracked-change suggestion. */
const suggestedDocJson = {
  revisionId: "rev-sug",
  tabs: [
    {
      tabProperties: { tabId: "t.0" },
      documentTab: {
        body: {
          content: [
            {
              paragraph: {
                elements: [
                  { startIndex: 1, endIndex: 22, textRun: { content: "Status: the draft is ", textStyle: {} } },
                  {
                    startIndex: 22,
                    endIndex: 38,
                    textRun: { content: "ready for review", textStyle: {}, suggestedInsertionIds: ["sug.1"] },
                  },
                  { startIndex: 38, endIndex: 46, textRun: { content: " today.\n", textStyle: {} } },
                ],
              },
            },
          ],
        },
      },
    },
  ],
};

/** A doc whose only match lives in a CHILD tab (docs_list_tabs surfaces its id). */
const childTabDocJson = {
  revisionId: "rev-child",
  tabs: [
    {
      tabProperties: { tabId: "t.0" },
      documentTab: { body: { content: [{ paragraph: { elements: [{ startIndex: 1, endIndex: 12, textRun: { content: "parent tab\n", textStyle: {} } }] } }] } },
      childTabs: [
        {
          tabProperties: { tabId: "t.0.1" },
          documentTab: {
            body: {
              content: [
                { paragraph: { elements: [{ startIndex: 1, endIndex: 14, textRun: { content: "nested draft\n", textStyle: {} } }] } },
              ],
            },
          },
        },
      ],
    },
  ],
};

const tool = TOOLS.find((t) => t.name === "docs_edit_text")!;
const ctx = { env: {} as Env, sub: "s1" };
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => new Response(JSON.stringify(init?.method === "POST" ? {} : docJson), { status: 200 }));
});

describe("docs_edit_text tool", () => {
  it("edits one single-style match with only insertText + deleteContentRange", async () => {
    const args = tool.inputSchema.parse({ documentId: "doc1", find: "ready for review", replace: "approved and final" });
    const { result } = await tool.run(ctx, args);
    expect(result).toEqual({
      ok: true,
      range: { startIndex: 22, endIndex: 40 },
      before: "ready for review",
      after: "approved and final",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("/documents/doc1:batchUpdate");
    const types = JSON.parse(init.body as string).requests.map((r: object) => Object.keys(r)[0]);
    expect(new Set(types)).toEqual(new Set(["insertText", "deleteContentRange"]));
  });

  it("returns mixedStyles and never calls batchUpdate when the match spans styles", async () => {
    const args = tool.inputSchema.parse({ documentId: "doc1", find: "is ready", replace: "was set" });
    const { result } = (await tool.run(ctx, args)) as { result: any };
    expect(result.ok).toBe(false);
    expect(result.mixedStyles).toBe(true);
    expect(result.runs.map((r: any) => r.content)).toEqual(["is ", "ready"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws Text not found for an absent match", async () => {
    const args = tool.inputSchema.parse({ documentId: "doc1", find: "nowhere", replace: "x" });
    await expect(tool.run(ctx, args)).rejects.toThrow(/Text not found/);
  });

  it("returns spansNonText and never calls batchUpdate when a footnote/image sits inside the match", async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify(footnoteDocJson), { status: 200 }));
    const args = tool.inputSchema.parse({ documentId: "doc1", find: "claim is", replace: "assertion holds" });
    const { result } = (await tool.run(ctx, args)) as { result: any };
    expect(result.ok).toBe(false);
    expect(result.spansNonText).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws Tab not found for an unknown tabId", async () => {
    const args = tool.inputSchema.parse({ documentId: "doc1", find: "ready for review", replace: "x", tabId: "t.9" });
    await expect(tool.run(ctx, args)).rejects.toThrow(/Tab not found: t\.9/);
  });

  it("pins the batch to the revision it read (writeControl.requiredRevisionId)", async () => {
    const args = tool.inputSchema.parse({ documentId: "doc1", find: "ready for review", replace: "approved" });
    await tool.run(ctx, args);
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string).writeControl).toEqual({ requiredRevisionId: "rev-abc" });
  });

  it("sends no writeControl when the document has no revisionId", async () => {
    const { revisionId: _drop, ...noRevision } = docJson;
    fetchSpy.mockImplementation(
      async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify(init?.method === "POST" ? {} : noRevision), { status: 200 }),
    );
    const args = tool.inputSchema.parse({ documentId: "doc1", find: "ready for review", replace: "approved" });
    const { result } = (await tool.run(ctx, args)) as { result: any };
    expect(result.ok).toBe(true);
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("writeControl");
  });

  it("returns hasSuggestions and never calls batchUpdate when the match carries a pending suggestion", async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify(suggestedDocJson), { status: 200 }));
    const args = tool.inputSchema.parse({ documentId: "doc1", find: "ready for review", replace: "approved" });
    const { result } = (await tool.run(ctx, args)) as { result: any };
    expect(result.ok).toBe(false);
    expect(result.hasSuggestions).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts a nested child tab id (docs_list_tabs flattens childTabs)", async () => {
    fetchSpy.mockImplementation(
      async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify(init?.method === "POST" ? {} : childTabDocJson), { status: 200 }),
    );
    const args = tool.inputSchema.parse({ documentId: "doc1", find: "nested draft", replace: "nested final", tabId: "t.0.1" });
    const { result } = (await tool.run(ctx, args)) as { result: any };
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("the not-found error says headers and footers are not searched", async () => {
    const args = tool.inputSchema.parse({ documentId: "doc1", find: "nowhere", replace: "x" });
    await expect(tool.run(ctx, args)).rejects.toThrow(/headers and footers are not searched/i);
  });
});
