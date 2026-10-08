import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));

import { TOOLS } from "../tools";

const ctx = { env: {} as Env, sub: "s1" };
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

/** A pageless doc with one child tab, as documents.get returns it. */
const rawDoc = {
  documentId: "doc1",
  title: "Scratch",
  revisionId: "rev-1",
  tabs: [
    {
      tabProperties: { tabId: "t.0", title: "Main", index: 0 },
      documentTab: {
        documentStyle: { documentFormat: { documentMode: "PAGELESS" }, marginTop: { magnitude: 72, unit: "PT" } },
        body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: 2, paragraph: { elements: [] } }] },
      },
      childTabs: [
        {
          tabProperties: { tabId: "t.1", title: "Notes", index: 0, parentTabId: "t.0", nestingLevel: 1 },
          documentTab: { documentStyle: { documentFormat: { documentMode: "PAGES" } }, body: { content: [] } },
        },
      ],
    },
  ],
};

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.restoreAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "POST") {
      return new Response(
        JSON.stringify({ documentId: "doc1", replies: [{}, {}], writeControl: { requiredRevisionId: "rev-2" } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(rawDoc), { status: 200 });
  });
});

/** The JSON body of the n-th fetch call. */
const bodyOf = (n: number) => JSON.parse((fetchSpy.mock.calls[n] as [string, RequestInit])[1].body as string);

describe("docs_batch_update (A1, A2)", () => {
  const requests = [{ insertText: { location: { index: 1 }, text: "Hi" } }, { insertText: { location: { index: 1 }, text: "A" } }];

  it("passes writeControl through and returns replies, the new revisionId and the request count", async () => {
    const args = tool("docs_batch_update").inputSchema.parse({
      documentId: "doc1",
      requests,
      writeControl: { requiredRevisionId: "rev-1" },
    });
    const { result } = (await tool("docs_batch_update").run(ctx, args)) as { result: any };
    expect(bodyOf(0).writeControl).toEqual({ requiredRevisionId: "rev-1" });
    expect(result).toEqual({ ok: true, documentId: "doc1", replies: [{}, {}], revisionId: "rev-2", requestCount: 2 });
  });

  it("passes writeMode SUGGEST through", async () => {
    const args = tool("docs_batch_update").inputSchema.parse({
      documentId: "doc1",
      requests,
      writeControl: { writeMode: "SUGGEST" },
    });
    await tool("docs_batch_update").run(ctx, args);
    expect(bodyOf(0).writeControl).toEqual({ writeMode: "SUGGEST" });
  });

  it("refuses requiredRevisionId together with targetRevisionId (Google allows one)", () => {
    expect(() =>
      tool("docs_batch_update").inputSchema.parse({
        documentId: "doc1",
        requests,
        writeControl: { requiredRevisionId: "a", targetRevisionId: "b" },
      }),
    ).toThrow(/not both/);
  });

  it("returns a typed REVISION_CONFLICT when Google rejects a stale requiredRevisionId", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: 400, status: "FAILED_PRECONDITION", message: "revision mismatch" } }), {
          status: 400,
        }),
    );
    const args = tool("docs_batch_update").inputSchema.parse({
      documentId: "doc1",
      requests,
      writeControl: { requiredRevisionId: "stale" },
    });
    const { result } = (await tool("docs_batch_update").run(ctx, args)) as { result: any };
    expect(result).toMatchObject({ ok: false, code: "REVISION_CONFLICT", requestCount: 2 });
  });

  it("keeps the failing request index on a validation error", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid requests[1].insertText: Index 9 must be less than 2." } }),
          { status: 400 },
        ),
    );
    const args = tool("docs_batch_update").inputSchema.parse({ documentId: "doc1", requests });
    const { result } = (await tool("docs_batch_update").run(ctx, args)) as { result: any };
    expect(result).toMatchObject({ ok: false, code: "INVALID_REQUEST", requestIndex: 1, requestType: "insertText" });
  });

  it("no longer claims the service-account identity", () => {
    expect(tool("docs_batch_update").description).not.toMatch(/service-account/i);
    expect(tool("docs_get_json").description).not.toMatch(/service-account/i);
  });
});

describe("read summary (A4)", () => {
  it("docs_get_json puts revisionId, documentMode and the flattened tab list first", async () => {
    const { result } = (await tool("docs_get_json").run(ctx, { documentId: "doc1" })) as { result: any };
    expect(Object.keys(result)[0]).toBe("summary");
    expect(result.summary).toEqual({
      documentId: "doc1",
      title: "Scratch",
      revisionId: "rev-1",
      documentMode: "PAGELESS",
      tabs: [
        { tabId: "t.0", title: "Main", parentTabId: null, nestingLevel: 0, documentMode: "PAGELESS" },
        { tabId: "t.1", title: "Notes", parentTabId: "t.0", nestingLevel: 1, documentMode: "PAGES" },
      ],
    });
    // The raw document is still all there, unchanged.
    expect(result.tabs).toEqual(rawDoc.tabs);
    expect(result.revisionId).toBe("rev-1");
  });
});

describe("docs_set_page_setup (A3)", () => {
  it("switches to PAGES and sets margins with an explicit field mask and tabId", async () => {
    const args = tool("docs_set_page_setup").inputSchema.parse({
      documentId: "doc1",
      documentMode: "PAGES",
      margins: { top: 36, bottom: 36, left: 36, right: 36 },
    });
    const { result } = (await tool("docs_set_page_setup").run(ctx, args)) as { result: any };
    // read (for tab + revision), write, re-read
    const post = bodyOf(1);
    expect(post.writeControl).toEqual({ requiredRevisionId: "rev-1" });
    expect(post.requests).toEqual([
      {
        updateDocumentStyle: {
          tabId: "t.0",
          documentStyle: {
            documentFormat: { documentMode: "PAGES" },
            marginTop: { magnitude: 36, unit: "PT" },
            marginBottom: { magnitude: 36, unit: "PT" },
            marginLeft: { magnitude: 36, unit: "PT" },
            marginRight: { magnitude: 36, unit: "PT" },
          },
          fields: "documentFormat.documentMode,marginTop,marginBottom,marginLeft,marginRight",
        },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.tabId).toBe("t.0");
  });

  it("only names the fields it sets, never '*'", async () => {
    const args = tool("docs_set_page_setup").inputSchema.parse({ documentId: "doc1", tabId: "t.1", margins: { left: 50 } });
    await tool("docs_set_page_setup").run(ctx, args);
    const req = bodyOf(1).requests[0].updateDocumentStyle;
    expect(req.fields).toBe("marginLeft");
    expect(req.tabId).toBe("t.1");
    expect(req.documentStyle).toEqual({ marginLeft: { magnitude: 50, unit: "PT" } });
  });

  it("sets the page size from a preset", async () => {
    const args = tool("docs_set_page_setup").inputSchema.parse({ documentId: "doc1", pageSize: "A4" });
    await tool("docs_set_page_setup").run(ctx, args);
    const req = bodyOf(1).requests[0].updateDocumentStyle;
    expect(req.fields).toBe("pageSize");
    expect(req.documentStyle.pageSize).toEqual({ width: { magnitude: 595.28, unit: "PT" }, height: { magnitude: 841.89, unit: "PT" } });
  });

  it("refuses a call that sets nothing", () => {
    expect(() => tool("docs_set_page_setup").inputSchema.parse({ documentId: "doc1" })).toThrow(/at least one/);
  });

  it("refuses an unknown tab", async () => {
    const args = tool("docs_set_page_setup").inputSchema.parse({ documentId: "doc1", tabId: "t.9", documentMode: "PAGES" });
    await expect(tool("docs_set_page_setup").run(ctx, args)).rejects.toThrow(/Tab not found: t\.9/);
  });
});
